// A Project Pip's "Reports to" picker with sessions that share a title (seen live, 12 Nov night: six "Say hello in
// three words." and nothing to tell them apart), in real Chromium, dark and light, at 700 and 300 px. Each choice says
// when its session is from, muted, at the row's right end, in the Work list's own words; the time never pushes the
// title off its one line (a long title ends in an ellipsis before it), and the delete dialog's "Move it to another
// session" list says the same after each title.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openOwnerPicker as openPicker } from "./support/pip-chat-scene.mjs";
import { openHome } from "./support/home-scene.mjs";
import { SESSION_PIPS_ASK, askSessionPips } from "./support/session-pips-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
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

const measure = (page) => page.evaluate(() => {
  const root = window.__pipsRoot || document, list = root.querySelector(".pip-owner-list"), l = list.getBoundingClientRect();
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const up = (n) => n.parentElement || (n.parentNode instanceof ShadowRoot ? n.parentNode.host : null);
  const ground = (e) => { const layers = []; for (let n = e; n; n = up(n)) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (e) => { const g = ground(e), c = over(parse(getComputedStyle(e).color), g), [a, b] = [lum(c), lum(g)].sort((p, q) => q - p); return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100; };
  const inked = (e) => { const r = document.createRange(); r.selectNodeContents(e); return r.getBoundingClientRect(); };
  return [...list.querySelectorAll("[data-owner-session]")].map((button) => {
    const title = button.querySelector(".pip-owner-title"), when = button.querySelector(".pip-owner-when"), b = button.getBoundingClientRect(), t = title.getBoundingClientRect();
    const lineHeight = parseFloat(getComputedStyle(title).lineHeight) || parseFloat(getComputedStyle(title).fontSize) * 1.4;
    const row = { id: button.dataset.ownerSession, title: title.textContent, oneLine: t.height <= lineHeight * 1.35 && getComputedStyle(title).whiteSpace === "nowrap", titleWidth: Math.round(t.width),
      titleCut: title.scrollWidth > title.clientWidth + 1, titleEllipsis: getComputedStyle(title).textOverflow === "ellipsis", inList: b.left >= l.left - 0.5 && b.right <= l.right + 0.5, titleRatio: ratio(title) };
    if (!when) return { ...row, when: null };
    const w = when.getBoundingClientRect(), ink = inked(when);
    return { ...row, when: when.textContent, whenWhole: ink.width <= w.width + 0.5 && when.scrollWidth <= when.clientWidth + 1, whenAfterTitle: w.left >= t.right - 0.5, whenInside: w.right <= b.right + 0.5 && w.left >= b.left,
      whenRight: Math.round(b.right - w.right), sameLine: w.top < t.bottom && w.bottom > t.top, whenRatio: ratio(when), muted: getComputedStyle(when).color !== getComputedStyle(title).color,
      whenSize: parseFloat(getComputedStyle(when).fontSize) };
  });
});

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`${theme} ${width}px: each same-titled session says when it is from at its row's end, and the title keeps its one line`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPicker(browser, { width, theme });
    try {
      const rows = await measure(x.p);
      assert.deepEqual(rows.map((r) => r.when), ["5m", "47m", "2h", "1d", "6d", "1w", "3w", null], "newest first, each by how long ago; No session has no time");
      assert.equal(rows.filter((r) => r.title === "Say hello in three words.").length, 6);
      const timed = rows.filter((r) => r.when);
      for (const r of timed) {
        assert.ok(r.oneLine, `${r.when}: the title is on one line`);
        assert.ok(r.whenWhole, `${r.when}: the time shows whole`);
        assert.ok(r.whenAfterTitle && r.sameLine, `${r.when}: after the title, on its line`);
        assert.ok(r.whenInside && r.inList, `${r.when}: inside its row, and the row inside the list`);
        assert.ok(r.muted, `${r.when}: muted, not the title's colour`);
        assert.ok(r.whenRatio >= 4.5, `${r.when} reads at ${r.whenRatio}:1`);
        assert.ok(r.titleRatio >= 4.5, `its title reads at ${r.titleRatio}:1`);
        assert.ok(r.titleWidth >= 80, `${r.when}: the title keeps room (${r.titleWidth}px)`);
      }
      assert.equal(new Set(timed.map((r) => r.whenRight)).size, 1, `every time ends at the same place, at the right (${timed.map((r) => r.whenRight)})`);
      assert.ok(timed[0].whenRight <= 12, "at the row's right end");
      // The short title is never cut for the time's sake; the long one ends in an ellipsis before it.
      for (const r of timed.filter((r) => r.title === "Say hello in three words.")) assert.ok(!r.titleCut, `${r.when}: “Say hello in three words.” shows whole`);
      const long = timed.find((r) => r.title.startsWith("Run the shell command"));
      assert.ok(long && long.titleEllipsis, "a long title is cut with an ellipsis");
      if (width === 300) assert.ok(long.titleCut, "at 300 px the long title gives way, not the time");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`${theme} ${width}px: the delete dialog's Move list says when each same-titled session is from, inside the dialog`, async (t) => {
    if (skipOrFail(t)) return;
    const home = await openHome(browser, { width, height: 760, theme: `${theme}-modern`, tab: "work" });
    try {
      const pad = (n) => String(n).padStart(2, "0");
      const ago = (minutes) => { const d = new Date(Date.now() - minutes * 60000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
      const sessions = [150, 26 * 60, 22 * 1440].map((m, i) => ({ id: `2026110${i + 1}-091200-b${i}`, title: "Say hello in three words.", when: ago(m) }));
      await askSessionPips(home.page, { ...SESSION_PIPS_ASK, sessions });
      const m = await home.page.evaluate(() => { const dialog = document.querySelector(".session-pips-dialog"), d = dialog.getBoundingClientRect(), select = dialog.querySelector(".session-pips-to"), s = select.getBoundingClientRect();
        return { options: [...select.options].map((o) => o.textContent), inside: s.left >= d.left - 0.5 && s.right <= d.right + 0.5, box: [Math.round(d.left), Math.round(d.right)] }; });
      assert.deepEqual(m.options, ["Say hello in three words. · 2h", "Say hello in three words. · 1d", "Say hello in three words. · 3w", "No session: their reports wait in the Pips view"]);
      assert.ok(m.inside && m.box[0] >= 0 && m.box[1] <= width, "the list stays inside the dialog, and the dialog inside the window");
      assert.deepEqual(home.errors, []);
    } finally { await home.page.context().close(); }
  });
}
