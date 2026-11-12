// Webhooks in (pips-22, Pips API 90), drawn by the real client and its CSS in real Chromium, in the side bar, at 700 and
// 300 px, dark and light (test/support/pip-chat-scene.mjs answers the commands itself; no tailscale command is run):
//   - a routine's panel under its card: nothing runs off the side, each address sits on one line beside its Copy and
//     is cut with an ellipsis when it is long (shown whole or not), its calls wrap inside the panel
//   - Pips settings → Webhooks: the same, with a long address of your own beside Turn off, and Tailscale's dialog
//     inside the window
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openChat } from "./support/pip-chat-scene.mjs";
import { openPanel as panelScene, openReach as reachScene } from "./support/pip-webhooks-scene.mjs";

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

const openPanel = (options) => panelScene(browser, options), openReach = (options) => reachScene(browser, options);
/** What a section measures as: anything that runs past it or the window, and each one-line address with its button. */
const measure = (p, sel) => p.evaluate((sel) => {
  const root = window.__pipsRoot || document, box = root.querySelector(sel), b = box.getBoundingClientRect(), vw = document.documentElement.clientWidth;
  const seen = (n) => n.getClientRects().length > 0 && n.checkVisibility({ visibilityProperty: true });
  const past = [...box.querySelectorAll("*")].filter(seen).filter((n) => { const r = n.getBoundingClientRect(); return r.right > Math.min(b.right, vw) + 0.5 || r.left < b.left - 0.5; })
    .map((n) => `${n.tagName.toLowerCase()}.${n.className} ${Math.round(n.getBoundingClientRect().left)}-${Math.round(n.getBoundingClientRect().right)}`);
  const lines = [...box.querySelectorAll(".webhook-address, .webhook-on")].filter(seen).map((row) => {
    const url = row.querySelector(".webhook-url"), act = row.querySelector("button"), u = url.getBoundingClientRect(), a = act.getBoundingClientRect(), s = getComputedStyle(url);
    return { way: row.dataset.hookWay || "on", text: url.textContent, cut: url.scrollWidth > url.clientWidth, ellipsis: s.textOverflow, wrap: s.whiteSpace, lines: Math.round(u.height / parseFloat(s.lineHeight) || 1),
      urlRight: u.right, actLeft: a.left, actRight: a.right, actWidth: a.width, sameLine: Math.abs((u.top + u.bottom) / 2 - (a.top + a.bottom) / 2) <= 3, act: act.textContent.trim() };
  });
  return { past, lines, width: b.width, vw, sideways: document.documentElement.scrollWidth > vw, text: box.innerText };
}, sel);

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`a routine's webhook panel, ${theme} ${width}px: nothing overflows, and a long address is cut beside Copy`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPanel({ width, theme, webhooks: { network: true, tunnel: "own", longBase: true, signing: true } });
    try {
      let v = await measure(x.p, "[data-webhook-panel]");
      assert.deepEqual(v.past, [], "nothing runs past the panel");
      assert.equal(v.sideways, false, "nothing runs off the side");
      assert.deepEqual(v.lines.map((l) => l.way), ["computer", "network", "internet"]);
      for (const l of v.lines) {
        assert.match(l.text, /^…\/(dgc|hooks)[^ ]*\/4ebed6…$/, `${l.way}: cut short (${l.text})`);
        assert.deepEqual([l.act, l.sameLine, l.lines], ["Copy", true, 1], `${l.way}: one line, Copy beside it`);
        assert.ok(l.urlRight <= l.actLeft + 0.5 && l.actRight <= v.vw, `${l.way}: Copy is whole, after the address`);
      }
      assert.ok(!(await x.p.content()).includes("4ebed60123456789"), "the whole address is not on the page");
      const cutButtons = await x.p.evaluate(() => [...(window.__pipsRoot || document).querySelectorAll("[data-webhook-panel] button")].filter((b) => b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim()));
      assert.deepEqual(cutButtons, [], "no button's words are cut");
      for (const words of ["Replace address", "Send a test call", "Stripe", "Refused: too many calls ×3", "Test (GitHub ping)", "Not run: the routine is off", "Waiting to run"])
        assert.ok(v.text.includes(words), `in the panel: ${words}`);
      // Shown whole: still one line beside Copy, cut with an ellipsis where it is too long for the row.
      await x.p.click("[data-hook-show]");
      v = await measure(x.p, "[data-webhook-panel]");
      assert.deepEqual(v.past, [], "shown: nothing runs past the panel");
      assert.equal(v.sideways, false);
      for (const l of v.lines) {
        assert.ok(l.text.endsWith("4ebed6" + "0123456789abcdef".repeat(3).slice(0, 42)), `${l.way}: the whole address`);
        assert.deepEqual([l.ellipsis, l.wrap, l.sameLine, l.lines], ["ellipsis", "nowrap", true, 1], `${l.way}: one line that ends in an ellipsis`);
        assert.ok(l.urlRight <= l.actLeft + 0.5 && l.actRight <= v.vw && l.actWidth >= 40, `${l.way}: Copy keeps its place and its size`);
      }
      if (width === 300) assert.ok(v.lines.every((l) => l.cut), "at 300 px every address is longer than its row");
      assert.ok(v.lines.find((l) => l.way === "internet").cut, "the long address of your own is cut");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Pips settings, Webhooks, ${theme} ${width}px: nothing overflows; Tailscale's dialog fits; a long address is cut beside Turn off`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openReach({ width, theme, webhooks: { refused: true, cloudflared: true } });
    try {
      let v = await measure(x.p, ".pip-page");
      assert.deepEqual(v.past, []);
      assert.equal(v.sideways, false);
      const tabs = await x.p.evaluate(() => [...(window.__pipsRoot || document).querySelectorAll(".pip-page-tabs button")].map((b) => { const r = b.getBoundingClientRect(); return [b.textContent, r.left >= 0 && r.right <= document.documentElement.clientWidth, b.scrollWidth <= b.clientWidth]; }));
      assert.deepEqual(tabs, [["Computer", true, true], ["Apps", true, true], ["Plugins", true, true], ["Webhooks", true, true]], "the four tabs are whole, inside the window");
      const whole = await x.p.evaluate(() => [...(window.__pipsRoot || document).querySelectorAll(".pip-page button:not(.seg)")].filter((b) => b.getClientRects().length && b.scrollWidth > b.clientWidth + 1).map((b) => b.textContent.trim()));
      assert.deepEqual(whole, [], "no button's words are cut");
      for (const words of ["This computer", "Your home network", "The internet", "Use Tailscale Funnel", "Use an address of your own", "Calls to an address no routine has", "×4"]) assert.ok(v.text.includes(words), words);
      const sw = await x.p.evaluate(() => { const r = (window.__pipsRoot || document).querySelector("label.switch:has(#hook-network)").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; });
      assert.deepEqual(sw, [36, 21], "the shared switch");
      // The dialog: Tailscale's own words, inside the window.
      await x.p.click("[data-reach-tailscale]");
      await x.p.waitForSelector("#review-root .dialog");
      const d = await x.p.evaluate(() => { const n = (window.__pipsRoot || document).querySelector("#review-root .dialog"), r = n.getBoundingClientRect();
        return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, vw: document.documentElement.clientWidth, vh: document.documentElement.clientHeight, text: n.innerText, inner: n.scrollWidth <= n.clientWidth + 1 }; });
      assert.ok(d.left >= 0 && d.right <= d.vw + 0.5 && d.top >= 0 && d.bottom <= d.vh + 0.5 && d.inner, `the dialog is inside the window (${JSON.stringify(d)})`);
      assert.match(d.text, /Turning it on makes only DGC's webhook path reachable from the internet/);
      await x.p.click("#review-confirm");
      await x.p.waitForSelector(".webhook-on");
      v = await measure(x.p, ".pip-page");
      assert.deepEqual(v.past, []);
      assert.equal(v.sideways, false);
      assert.deepEqual(v.lines.map((l) => [l.way, l.act, l.sameLine, l.lines, l.ellipsis]), [["on", "Turn off", true, 1, "ellipsis"]]);
      assert.ok(v.text.includes("The first call can take a few minutes to get through after you turn it on."));
      assert.deepEqual(await x.p.evaluate(() => window.__hooks.asked.filter((r) => r.type === "set_webhook_reach").map((r) => r.tunnel)), ["tailscale"]);
      // A long address of your own, saved from the folded form.
      await x.p.click("[data-reach-off]");
      await x.p.waitForSelector("[data-reach-tailscale]");
      await x.p.click("details.webhook-own > summary");
      await x.p.fill("#hookOwnBase", "https://hooks.a-rather-long-company-name-for-a-tunnel.example.com/services/incoming/dgc");
      v = await measure(x.p, ".pip-page");
      assert.deepEqual(v.past, [], "the form, open");
      await x.p.click("[data-reach-own-form] button[type=submit]");
      await x.p.waitForSelector(".webhook-on");
      v = await measure(x.p, ".pip-page");
      assert.deepEqual(v.past, []);
      assert.equal(v.sideways, false);
      const on = v.lines[0];
      assert.ok(on.urlRight <= on.actLeft + 0.5 && on.actRight <= v.vw && on.sameLine && on.lines === 1, "the address and Turn off share a line");
      if (width === 300) assert.ok(on.cut, "cut with an ellipsis at 300 px");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("the routine form with the new choice, 300 px: its line is under it and nothing overflows", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openChat(browser, { width: 300, height: 1000, theme: "dark", api: 90, settings: true, webhooks: true });
  try {
    await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click());
    await x.p.click("[data-routine-new]");
    await x.p.selectOption("#routineKind", "webhook");
    await x.p.waitForFunction(() => /DGC makes a secret address for it/.test((window.__pipsRoot || document).querySelector("#routine-form")?.textContent || ""));
    const v = await x.p.evaluate(() => { const f = (window.__pipsRoot || document).querySelector("#routine-form"), r = f.getBoundingClientRect();
      return { chosen: f.querySelector("#routineKind").selectedOptions[0].textContent, inside: [...f.querySelectorAll("*")].every((n) => n.getBoundingClientRect().right <= r.right + 0.5), sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth }; });
    assert.deepEqual(v, { chosen: "A service calls its address", inside: true, sideways: false });
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
