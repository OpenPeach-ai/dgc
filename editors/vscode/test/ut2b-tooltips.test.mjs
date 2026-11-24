// User test round 2 (W12, A5, L2): a hover label stayed on screen for minutes after the pointer had gone. Work's page
// draws its own label (media/main.js) and it only ever hid on the NEXT thing pointed at inside the page: a pointer that
// left the page (into the editor, another tab), a scroll, or a control drawn again under a still pointer after a click
// all left it standing. Held here for Work's page and for the shared label every other page uses (media/shared/tip.js).
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { chromiumFor } from "./support/ut2b-common.mjs";
import * as S from "./support/uir2a-scene.mjs";
import { openSettings } from "./support/settings-scene.mjs";

const C = await chromiumFor();
before(C.start); after(C.stop);

const shown = (page) => page.evaluate(() => { const n = document.querySelector(".tip[role=tooltip]:not([hidden]), .dgc-tip:not([hidden])"); return n ? n.textContent : ""; });
const leavePage = (page, sel) => page.evaluate((s) => { const n = document.querySelector(s);
  n.dispatchEvent(new PointerEvent("pointerout", { bubbles: true, composed: true, relatedTarget: null }));
  document.documentElement.dispatchEvent(new MouseEvent("mouseleave", { bubbles: false, relatedTarget: null })); }, sel);

test("Work: a label goes when the pointer leaves the page, when the page scrolls, and does not come back on a control drawn again under a click", async (t) => {
  if (C.skipOrFail(t)) return;
  const x = await S.openWork(C.state.browser, { width: 440, turns: 3 });
  try {
    const p = x.page, sel = "#btn-add";
    await p.hover(sel); await p.waitForTimeout(1000);
    assert.ok(await shown(p), "premise: the label shows under a resting pointer");
    await leavePage(p, sel); await p.waitForTimeout(80);
    assert.equal(await shown(p), "", "the pointer left the page: the label goes");
    assert.ok(await p.evaluate((s) => document.querySelector(s).getAttribute("title"), sel), "and the control's title is back");

    await p.mouse.move(5, 5); await p.hover(sel); await p.waitForTimeout(1000);
    assert.ok(await shown(p), "premise: it shows again");
    await p.evaluate(() => { const log = document.getElementById("log"); log.scrollTop = 0; log.dispatchEvent(new Event("scroll")); }); await p.waitForTimeout(80);
    assert.equal(await shown(p), "", "the page scrolled under it: the label goes");

    // A control drawn again where the pointer has just clicked (a filter, a star) is not pointed at anew.
    await p.mouse.move(5, 5);
    await p.evaluate(() => { const b = document.createElement("button"); b.id = "ut2b-again"; b.title = "Showing only your favorites"; b.textContent = "Star";
      b.style.cssText = "position:fixed;left:120px;top:200px;z-index:50;width:60px;height:28px";
      b.addEventListener("click", () => { const c = b.cloneNode(true); c.title = "Showing everything"; b.replaceWith(c); }); document.body.append(b); });
    await p.mouse.move(150, 214); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(1200);
    assert.equal(await shown(p), "", "no label pops up over what was just clicked");
    await p.mouse.move(5, 5); await p.mouse.move(150, 214, { steps: 3 }); await p.waitForTimeout(1000);
    assert.equal(await shown(p), "Showing everything", "pointing at it again labels it as usual");
    assert.deepEqual(x.errors, []);
  } finally { await x.page.close(); }
});

test("Work: a label whose control is no longer under the pointer goes by itself", async (t) => {
  if (C.skipOrFail(t)) return;
  const x = await S.openWork(C.state.browser, { width: 440, turns: 1 });
  try {
    const p = x.page, sel = "#btn-add";
    await p.hover(sel); await p.waitForTimeout(1000);
    assert.ok(await shown(p), "premise: the label shows");
    // Something comes to lie over the control (a panel, a dialog): no pointer event reaches the page's own listeners.
    await p.evaluate(() => { const cover = document.createElement("div"); cover.style.cssText = "position:fixed;inset:0;z-index:40"; cover.addEventListener("pointerover", (e) => e.stopPropagation(), true);
      window.addEventListener("pointerover", (e) => { if (e.target === cover) e.stopImmediatePropagation(); }, true); document.body.append(cover); });
    await p.mouse.move(200, 300); await p.mouse.move(210, 310); await p.waitForTimeout(800);
    assert.equal(await shown(p), "", "the control is not hovered any more: its label is gone");
  } finally { await x.page.close(); }
});

test("every other page (the shared label): it goes when the pointer leaves the page and never returns over a click", async (t) => {
  if (C.skipOrFail(t)) return;
  const x = await openSettings(C.state.browser, { width: 700, height: 700 });
  const p = x.page || x.p;
  try {
    await p.evaluate(() => { const b = document.createElement("button"); b.id = "ut2b-again"; b.title = "Showing only your favorites"; b.textContent = "Star";
      b.style.cssText = "position:fixed;left:120px;top:200px;z-index:50;width:60px;height:28px";
      b.addEventListener("click", () => { const c = b.cloneNode(true); c.title = "Showing everything"; b.replaceWith(c); }); document.body.append(b); });
    await p.mouse.move(150, 214, { steps: 3 }); await p.waitForTimeout(1000);
    assert.equal(await shown(p), "Showing only your favorites", "premise: the label shows");
    await leavePage(p, "#ut2b-again"); await p.waitForTimeout(80);
    assert.equal(await shown(p), "", "the pointer left the page: the label goes");
    await p.mouse.move(5, 5); await p.mouse.move(150, 214, { steps: 3 }); await p.mouse.down(); await p.mouse.up(); await p.waitForTimeout(1200);
    assert.equal(await shown(p), "", "no label pops up over what was just clicked");
  } finally { await (x.close ? x.close() : p.close()); }
});
