// A Pip's page, batch of 14 Nov (0.52), in real Chromium on the stand-in DGC of test/support/one-pips-scene.mjs, in the
// side bar's real page at 300 and 700 px, dark and light: the dollar limits under "Payments", "Knows about you" beside
// "What it remembers", "Sent to the web" opened, "All Pips together" in Pips settings, and the Mac dialog. Layout is a
// fact only a real browser can check: nothing runs off the side or is cut, every field and button is the one family
// (the 6 px corner, the button's height), and a sentence with a blank keeps the blank beside its words.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GST, MORNINGS, openOnePips } from "./support/one-pips-scene.mjs";
import { PAYING, openPage } from "./support/pip-page-batch-scene.mjs";

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
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

/** What is drawn of `selector` (inside the Pips view): boxes, corners, and whether anything is cut or off the side. */
const measure = (x, selector) => x.inPips((root, sel) => {
  const host = root.querySelector(sel);
  if (!host) return null;
  const page = root.querySelector(".pip-page") || root.querySelector(".pip-app-root"), edge = page.getBoundingClientRect();
  const box = (n) => { const r = n.getBoundingClientRect(), s = getComputedStyle(n); return { id: n.id || n.className || n.tagName, tag: n.tagName, type: n.type || "", left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height,
    r: parseFloat(s.borderTopLeftRadius) || 0, cut: n.scrollWidth > n.clientWidth + 1 && s.overflowX !== "visible", color: s.color }; };
  return { host: box(host), edge: { left: edge.left, right: edge.right }, controls: [...host.querySelectorAll("input, select, button")].filter((n) => n.checkVisibility()).map(box),
    words: [...host.querySelectorAll("label, small, strong, p, .pay-unit, .pay-status, .sent-host")].filter((n) => n.checkVisibility()).map(box),
    sideways: document.documentElement.scrollWidth > document.documentElement.clientWidth, pageSideways: page.scrollWidth > page.clientWidth + 1 };
}, selector);
function fits(m, what) {
  assert.ok(m, `${what}: drawn`);
  for (const c of [...m.controls, ...m.words]) {
    assert.ok(c.left >= m.edge.left - 0.5 && c.right <= m.edge.right + 0.5, `${what}: ${c.id} stays inside the page (${Math.round(c.left)}..${Math.round(c.right)} of ${Math.round(m.edge.left)}..${Math.round(m.edge.right)})`);
    assert.equal(c.cut, false, `${what}: ${c.id} is not cut`);
  }
  assert.equal(m.sideways, false, `${what}: the view does not scroll sideways`);
  assert.equal(m.pageSideways, false, `${what}: the page does not scroll sideways`);
}
/** Fields and buttons are the one family: the 6 px corner and the button's height (a tick box and a switch keep their own shape). */
function family(m, what) {
  for (const c of m.controls.filter((c) => !["checkbox", "radio"].includes(c.type) && !/pip-page-row|pip-tip-btn/.test(c.id))) {
    assert.equal(c.r, 6, `${what}: ${c.id} has the 6 px corner (${c.r})`);
    assert.equal(Math.round(c.h), 28, `${what}: ${c.id} is the button's height (${c.h})`);
  }
}

for (const theme of ["dark", "light"]) for (const width of [300, 700]) {
  const tag = `${theme} ${width}px`;
  test(`its limits for paying by itself, ${tag}: three sentences with their blanks, Save, nothing cut`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, height: 900, theme: `${theme}-modern`, scene: PAYING });
    try {
      await openPage(x, MORNINGS);
      await x.inPips((root) => root.querySelector("#pip-pay-form").scrollIntoView({ block: "center" }));
      const m = await measure(x, "#pip-pay-form");
      fits(m, "limits"); family(m, "limits");
      const by = Object.fromEntries([...m.controls, ...m.words].map((c) => [c.id, c]));
      // "$" and its box are one thing, and "a day" follows on the same line: the sentence reads across.
      const money = await x.inPips((root) => { const b = (s) => root.querySelector(s).getBoundingClientRect(); const sign = b("#pip-pay-form .pay-sign"), box = b("#payUsd"), unit = b(".pay-daily .pay-unit"), label = b('label[for="payUsd"]');
        return { sign: [sign.right, (sign.top + sign.bottom) / 2], box: [box.left, (box.top + box.bottom) / 2, box.right], unit: [unit.left, (unit.top + unit.bottom) / 2], label: (label.top + label.bottom) / 2 }; });
      assert.ok(money.box[0] - money.sign[0] >= 0 && money.box[0] - money.sign[0] <= 8, `"$" sits against its box (${money.box[0] - money.sign[0]})`);
      assert.ok(Math.abs(money.sign[1] - money.box[1]) <= 1.5, "\"$\" is on the box's line");
      assert.ok(Math.abs(money.unit[1] - money.box[1]) <= 1.5 && money.unit[0] >= money.box[2], "\"a day\" follows the box on its line");
      if (width >= 700) assert.ok(Math.abs(money.label - money.box[1]) <= 1.5, "at 700 px the whole sentence is one line");
      assert.ok(by["pip-pay-save"], "Save");
      assert.ok(by.pipPayStatus.w > 60, "what it used today is in sight");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`Knows about you and Sent to the web, ${tag}: the switch is the page's switch, the opened list fits`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, height: 900, theme: `${theme}-modern`, scene: PAYING });
    try {
      await openPage(x, GST);
      const sw = await x.inPips((root) => { const b = (s) => { const r = root.querySelector(s).closest(".switch").getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height), Math.round(r.right)]; }; return { knows: b("#pipKnowsYou"), notify: b("#pipNotify") }; });
      assert.deepEqual(sw.knows, sw.notify, "the same switch as Notifications, at the same right edge");
      fits(await measure(x, ".pip-knows-you"), "Knows about you");
      await x.click("#pip-sent-toggle");
      await x.waitIn("#pip-sent-list");
      await x.inPips((root) => root.querySelector(".pip-sent").scrollIntoView({ block: "center" }));
      const m = await measure(x, ".pip-sent");
      fits(m, "Sent to the web");
      const look = await x.inPips((root) => { const s = (q) => getComputedStyle(root.querySelector(q)); const note = root.querySelector(".pip-sent-note").getBoundingClientRect(), list = root.querySelector("#pip-sent-list").getBoundingClientRect();
        return { blocked: s(".sent-blocked").color, quiet: s("#pip-sent-list small").color, under: note.top >= list.bottom - 0.5, rows: root.querySelectorAll("#pip-sent-list li").length, badge: root.querySelectorAll("#pip-sent-toggle .badge, #pip-sent-toggle b").length }; });
      assert.equal(look.rows, 3);
      assert.notEqual(look.blocked, look.quiet, "a blocked one stands out from the quiet line it is in");
      assert.ok(look.under, "DGC's note is under the list");
      assert.equal(look.badge, 0, "no badge on the row");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`All Pips together in Pips settings, ${tag}: one row, its box and Save in the one family`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, height: 900, theme: `${theme}-modern`, scene: { total: { usd_per_day: 200, spent_today: 31.4 } } });
    try {
      await x.click("#pips-settings-open");
      await x.waitIn('[data-pips-settings="apps"]');
      await x.click('[data-pips-settings="apps"]');
      await x.waitIn("#pips-pay-total-form");
      await x.page.waitForTimeout(200);
      const m = await measure(x, "#pips-pay-total-form");
      fits(m, "All Pips together"); family(m, "All Pips together");
      assert.equal(await x.inPips((root) => root.querySelector("#payTotal").value), "200");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });

  test(`the Mac dialog, ${tag}: inside the side bar, its words whole, OK the one button`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openOnePips(browser, { width, height: 760, theme: `${theme}-modern`, scene: { boxes: { available: false, why: "Needs macOS 26." } } });
    try {
      await x.send({ type: "pipsMacNote" });
      await x.page.waitForSelector("#pips-mac-note:not([hidden])");
      await x.page.waitForTimeout(200);
      const v = await x.page.evaluate(() => { const layer = document.getElementById("pips-mac-note"), d = layer.querySelector(".pw-dialog").getBoundingClientRect(), ok = layer.querySelector("button"), o = ok.getBoundingClientRect(), s = getComputedStyle(ok);
        const cut = [...layer.querySelectorAll(".pw-title, .pw-lead")].some((n) => n.scrollWidth > n.clientWidth + 1 || n.getBoundingClientRect().right > d.right);
        const body = layer.querySelector(".pw-body");
        return { d: [d.left, d.right, d.top, d.bottom, d.width], vw: innerWidth, vh: innerHeight, ok: [o.width, o.height, parseFloat(s.borderTopLeftRadius), o.right, o.bottom], cut, scrolls: body.scrollHeight > body.clientHeight + 1,
          focus: document.activeElement === ok, over: document.elementFromPoint(d.left + d.width / 2, d.top + 20)?.closest("#pips-mac-note") !== null, pipsShown: !document.getElementById("pips-host").hidden }; });
      assert.ok(v.d[0] >= 12 - 0.5 && v.d[1] <= v.vw - 12 + 0.5 && v.d[2] >= 12 - 0.5 && v.d[3] <= v.vh - 12 + 0.5, `the dialog is inside the side bar with its margin (${v.d.map(Math.round)})`);
      assert.ok(v.d[4] <= 440, "at most the welcome's width");
      assert.equal(v.cut, false, "no word is cut");
      assert.equal(v.scrolls, false, "all of it is in sight without scrolling");
      assert.deepEqual([Math.round(v.ok[1]), v.ok[2]], [28, 6], "OK is the one button: 28 px, the 6 px corner");
      assert.ok(v.ok[3] <= v.d[1] - 12 && v.ok[4] <= v.d[3] - 10, "OK sits inside the dialog's foot");
      assert.ok(v.focus, "OK has the focus");
      assert.ok(v.over && v.pipsShown, "over the Pips tab");
      await x.page.keyboard.press("Tab");
      assert.ok(await x.page.evaluate(() => document.activeElement === document.querySelector("#pips-mac-note button")), "the keyboard stays in it");
      await x.page.keyboard.press("Enter");
      await x.page.waitForSelector("#pips-mac-note[hidden]", { state: "attached" });
      assert.deepEqual((await x.posted("pipsMacNoteSeen")).length, 1, "OK answers it");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
