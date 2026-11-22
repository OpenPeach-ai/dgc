// The layout audit on a view that draws itself again while a layer is open (the Pips view replaces its nodes whenever
// what it shows changes: a Pip's state, a pin, something new to read). The audit kept each open layer as the node it
// had measured, so a redraw between two of its looks left it holding a node that was no longer in the page: the menu
// was still open on screen, and the audit read no rows in it ("“Open in editor” … no control offers it … and none of
// the 1 menu there has it"), or found the keyboard's focus outside it ("doesn't take the focus"). On a quiet machine
// its looks are a few milliseconds apart and a redraw seldom lands between them; on a busy one it did.
// Here the redraw is made to land there, on the real Pips list in real Chromium: a layer is the one that is open, by
// what it is, whichever node draws it now.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openOnePips, GST, MORNINGS } from "./support/one-pips-scene.mjs";
import { installProbe } from "./layout-audit/probe.mjs";

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

const la = (page, fn, arg) => page.evaluate(([f, a]) => window.__la[f](a), [fn, arg]);
async function open(width = 300) {
  const x = await openOnePips(browser, { theme: "dark-modern", width, height: 760, where: "side", scene: { fix: "ask", unread: { [GST]: { id: "msg_" + "7".repeat(32), latest: "Tonight's check found 3 things." } } } });
  await x.page.evaluate(installProbe);
  // Every redraw of the list is counted where it happens: its rows are new nodes.
  await x.page.evaluate(() => { const root = document.getElementById("pips-host").shadowRoot; window.__redraws = 0;
    new MutationObserver((list) => { if (list.some((m) => [...m.addedNodes].some((n) => n.nodeType === 1 && (n.matches?.("[data-job]") || n.querySelector?.("[data-job]"))))) window.__redraws++; }).observe(root, { childList: true, subtree: true }); });
  let pinned = false;
  /** The list draws itself again, with new nodes (a Pip pinned to the dock or taken off it), and has done so. */
  const redraw = async () => { const n = await x.page.evaluate(() => window.__redraws); pinned = !pinned;
    await x.send({ type: "dock", pinned: pinned ? [`pip:${MORNINGS}`] : [] });
    await x.page.waitForFunction((was) => window.__redraws > was, n); };
  /** Presses the control the probe numbered `i`, and waits for the layer it opens. */
  const press = async (i) => { const aim = await la(x.page, "aim", i); await x.page.mouse.move(aim.x, aim.y); await la(x.page, "snap"); await x.page.mouse.click(aim.x, aim.y);
    await x.page.waitForFunction((k) => { const r = window.__la.opened(k); return r.layers.length > 0 || window.__la.layers.some((l) => l && l.isConnected); }, i);
    return x.page.evaluate(() => window.__la.layers.findLastIndex((l) => l && l.isConnected)); };
  return { ...x, redraw, press };
}

test("a row's “…” menu, open through a redraw of the list, is still read: its rows, that it is open, its mark", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(300);
  try {
    const more = (await la(x.page, "triggers", { scope: "div.pip-row-slot", most: 1, menus: true })).find((c) => /^More for/.test(c.label));
    assert.ok(more, "a row of the narrow list has its “…”");
    const k = await x.press(more.i);
    assert.ok((await la(x.page, "menuWords")).includes("Open in editor"), "the menu has Open in editor");
    await x.redraw();
    const shown = await x.inPips((root) => !!root.querySelector("#pip-row-menu")?.checkVisibility());
    assert.equal(shown, true, "premise: the redraw leaves the menu open on screen (the page's own rule)");
    assert.ok((await la(x.page, "menuWords")).includes("Open in editor"), "the open menu's rows are read after the redraw: Open in editor is there");
    assert.equal((await la(x.page, "closed", [k, more.i])).open, true, "and it is still called open");
    assert.equal(await x.inPips((root, n) => root.querySelector(`[data-la-layer="${n}"]`)?.id || "", k), "pip-row-menu", "the node that draws it now wears the layer's mark (its words are audited by that mark)");
    // What was open before a press is not what the press opened, though a redraw has made it of new nodes.
    await la(x.page, "snap"); await x.redraw();
    assert.deepEqual((await la(x.page, "opened", -1)).layers.map((m) => m.what), [], "a layer that was open at the snap is not a new one after a redraw");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("Controls, opened by the keyboard: the focus inside it is found there after a redraw, and Escape is seen to close it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(300);
  try {
    const controls = (await la(x.page, "triggers", { most: 2 })).find((c) => /^Controls/.test(c.label));
    assert.ok(controls, "the list has Controls");
    assert.equal((await la(x.page, "focus", controls.i)).ok, true);
    await la(x.page, "snap"); await x.page.keyboard.press("Enter");
    await x.page.waitForFunction((i) => window.__la.opened(i).layers.length > 0 || window.__la.layers.some((l) => l && l.isConnected), controls.i);
    const k = await x.page.evaluate(() => window.__la.layers.findLastIndex((l) => l && l.isConnected));
    await x.page.keyboard.press("Tab");
    assert.equal(await la(x.page, "focusIn", k), true, "Tab goes into the menu");
    await x.redraw();
    const where = await x.inPips((root) => { const a = root.activeElement; return !!a && !!a.closest("details.runner-controls[open] > .runner-menu"); });
    assert.equal(where, true, "premise: the page keeps the focus in the open menu through its redraw");
    assert.equal(await la(x.page, "focusIn", k), true, "and the audit finds it there");
    await x.page.keyboard.press("Escape");
    await x.page.waitForFunction(() => !document.getElementById("pips-host").shadowRoot.querySelector("details.runner-controls[open]"));
    const closed = await la(x.page, "closed", [k, controls.i]);
    assert.deepEqual([closed.open, closed.focusBack], [false, true], `Escape closes it and the focus is back on Controls: ${closed.focus}`);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
