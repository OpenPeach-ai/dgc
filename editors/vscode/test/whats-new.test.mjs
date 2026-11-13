// "What's new in 0.52" (pips-flow-design §3.3, item 1; src/whatsNew.ts, media/shared/whatsnew.js): a dialog in the side
// bar the first time 0.52's side bar is shown. A 16:9 picture drawn in the page (no image file), the feature's name
// and its short text, dots, Skip / Next (the last slide: Done), the arrow keys. Never again after Skip, Done or Esc,
// kept in the editor's global state so every window of this editor agrees; opened again from the DGC view's ⋯ menu
// ("What's New"). Slide 6 is a list, so a line that didn't ship isn't shown.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DgcViewProvider, cleanup, extensionRoot } from "./support/panel-bundle.mjs";
import { openHome } from "./support/home-scene.mjs";

const made = [];
after(() => { for (const p of made) { try { p.dispose(); } catch { /* already gone */ } } cleanup(); });
const KEY = "dgc.whatsNewSeen";

/** The editor's global state, shared by every window's provider (as the editor shares it). */
function memory(initial = {}) { const kept = new Map(Object.entries(initial)); return { kept, get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, v); } }; }
function provider(globalState, { home = true, tab = false } = {}) {
  const context = { extension: { packageJSON: JSON.parse(readFileSync(`${extensionRoot}/package.json`, "utf8")) }, extensionUri: { fsPath: "/ext" }, subscriptions: [],
    secrets: { async get() {}, async store() {}, async delete() {} }, globalState, workspaceState: { get() {}, async update() {} } };
  const places = { current: () => undefined, open: () => undefined, openSessions: () => new Set(), changed() {} };
  const p = tab ? new DgcViewProvider(context, { key: "0123456789abcdef", session: "", places, host: provider(globalState).p, title() {}, restored: false }) : new DgcViewProvider(context);
  made.push(p);
  const posted = [];
  p.post = (m) => { posted.push(m); };
  p.webviewReady = true;
  p.ensureBackend = () => ({ ready: false, send() { return false; }, sendSetup() { return false; }, request: async () => ({}), dispose() {} });
  if (home && !tab) { p.places = places; p.home = true; }
  return { p, posted, news: () => posted.filter((m) => m.type === "whatsNew") };
}

// ---- the host: when it shows, and that it never shows again ------------------------------------------------------------

test("shown once, by itself, the first time the side bar's page is up; never in a session's tab", () => {
  const state = memory();
  const side = provider(state);
  side.p.offerWhatsNew();
  assert.deepEqual(side.news(), [{ type: "whatsNew", auto: true, release: "0.52" }]);
  // The page drawn again before it was answered (the side bar hidden and shown) may show it again: it wasn't read.
  side.p.offerWhatsNew();
  assert.equal(side.news().length, 2);
  const tab = provider(memory(), { tab: true });
  tab.p.offerWhatsNew();
  assert.deepEqual(tab.news(), [], "a tab is not the side bar");
  const plain = provider(memory(), { home: false });
  plain.p.offerWhatsNew();
  assert.deepEqual(plain.news(), [], "nor a page that is not the Sessions home");
});

test("Skip, Done or Esc: kept in the editor's global state, so no window shows it by itself again", async () => {
  const state = memory();
  const one = provider(state), two = provider(state);
  one.p.offerWhatsNew();
  assert.equal(one.news().length, 1);
  await one.p.onMessage({ type: "whatsNewSeen" });
  assert.equal(state.kept.get(KEY), "0.52", "what was seen is this release's");
  one.p.offerWhatsNew();
  assert.equal(one.news().length, 1, "never again in this window");
  two.p.offerWhatsNew();
  assert.deepEqual(two.news(), [], "nor in another window of this editor");
});

test("an earlier release's seen mark doesn't hide this one's; a later one shows its own", () => {
  const older = provider(memory({ [KEY]: "0.51" }));
  older.p.offerWhatsNew();
  assert.equal(older.news().length, 1);
  const odd = provider(memory({ [KEY]: 52 }));
  odd.p.offerWhatsNew();
  assert.equal(odd.news().length, 1, "only this release's own mark counts");
});

test("opened again from the menu, whenever asked: seen or not, and without changing what was seen", async () => {
  const state = memory({ [KEY]: "0.52" });
  const side = provider(state);
  side.p.showWhatsNew();
  assert.deepEqual(side.news(), [{ type: "whatsNew", auto: false, release: "0.52" }]);
  await side.p.onMessage({ type: "whatsNewSeen" });
  assert.equal(state.kept.get(KEY), "0.52");
});

test("the menu: What's New is a command in the DGC view's ⋯ menu (both side bars), not one more icon in its title bar", () => {
  const manifest = JSON.parse(readFileSync(`${extensionRoot}/package.json`, "utf8"));
  const command = manifest.contributes.commands.find((c) => c.command === "dgc.whatsNew");
  assert.ok(command, "the command");
  assert.equal(command.title, "What's New");
  assert.equal(command.category, "DGC");
  const entry = manifest.contributes.menus["view/title"].find((m) => m.command === "dgc.whatsNew");
  assert.ok(entry, "in the view's title menu");
  assert.match(entry.when, /view == dgc\.chat\b/); assert.match(entry.when, /view == dgc\.chatSecondary\b/);
  assert.ok(entry.group && !/^navigation/.test(entry.group), "any group but navigation is the ⋯ menu");
  const source = readFileSync(`${extensionRoot}/src/extension.ts`, "utf8");
  assert.match(source, /registerCommand\("dgc\.whatsNew"/, "and it is registered");
});

// ---- the page, in Chromium -----------------------------------------------------------------------------------------

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const SLIDES = [
  ["Pips are one kind now", "No more Personal and Project Pips. One list, one New Pip. Every Pip has its own chat, its own computer, and, if you give it a folder, its own copy of that folder to work in. A Pip tells you what it finds in its own chat. What needs you is on Home."],
  ["Each Pip works behind a wall", "Inside its own computer a Pip never asks. Only what crosses the wall does: changing your folder, sending, posting, paying. You choose how much it asks: Ask me first, Approve for me, or Do it all."],
  ["Pips tell you, then fix", "When a check finds something, the Pip says what is wrong and why, fixes it in its own copy, and shows you the change to apply. What only you can do is said once and kept in one place."],
  ["Home is yours", "Home is now cards: Needs you, Recent, Running now, Token usage and more. Add, remove and arrange them with Cards; they change shape with the width."],
  ["Work, tidier", "Archive and restore sessions. A goal now runs as turns you can follow. Type @ and a Pip's name to hand it a job; its answer comes back to that session."],
  ["Also new", "Change settings by asking. A fallback model on every surface. Incognito chats."],
];
/** The dialog as it is on screen, or null when it is closed. */
const now = (page) => page.evaluate(() => {
  const layer = document.getElementById("whats-new");
  if (!layer || layer.hidden || !layer.checkVisibility()) return null;
  const box = layer.querySelector(".wn-dialog"), pic = layer.querySelector(".wn-picture"), r = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const buttons = [...layer.querySelectorAll(".wn-actions button")].filter((b) => !b.hidden);
  const words = (n) => (n?.textContent || "").replace(/\s+/g, " ").trim();
  return { role: layer.getAttribute("role"), modal: layer.getAttribute("aria-modal"), labelled: document.getElementById(layer.getAttribute("aria-labelledby"))?.textContent || "",
    kicker: words(layer.querySelector(".wn-kicker")), title: words(layer.querySelector(".wn-title")), text: words(layer.querySelector(".wn-text")),
    dots: layer.querySelectorAll(".wn-dot").length, at: [...layer.querySelectorAll(".wn-dot")].findIndex((d) => d.classList.contains("on")), step: words(layer.querySelector(".wn-step")),
    buttons: buttons.map((b) => b.textContent.trim()), focus: document.activeElement?.textContent?.trim() || "",
    shapes: buttons.map((b) => { const cs = getComputedStyle(b); return [cs.borderTopLeftRadius, b.offsetHeight].join(" "); /* (its laid-out height: the dialog arrives with 2% of scale) */ }),
    box: r(box), picture: r(pic), scene: pic.dataset.scene || "", images: layer.querySelectorAll("img, picture, image, video, canvas").length,
    drawn: pic.querySelectorAll("*").length, clipped: [...pic.querySelectorAll("*")].filter((n) => { const b = n.getBoundingClientRect(), p = pic.getBoundingClientRect(); return b.width && (b.left < p.left - 0.5 || b.right > p.right + 0.5 || b.top < p.top - 0.5 || b.bottom > p.bottom + 0.5); }).length,
    overflowX: document.documentElement.scrollWidth > innerWidth, width: innerWidth, height: innerHeight, textFits: box.scrollHeight <= box.clientHeight + 1 || getComputedStyle(box).overflowY !== "visible" };
});
const seen = (x) => x.posted("whatsNewSeen");
const open = async (options = {}, message = { type: "whatsNew", auto: true, release: "0.52" }) => {
  const x = await openHome(browser, { width: 300, height: 760, ...options });
  x.page.setDefaultTimeout(10000);
  try {
    await x.send(message);
    await x.page.waitForSelector("#whats-new:not([hidden])");
  } catch (error) { await x.close(); throw error; }
  return x;
};

test("the dialog: a picture on top, the name and its text below, six dots, Skip and Next; Next walks the six slides to Done", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open({ width: 460 });
  try {
    const first = await now(x.page);
    assert.equal(first.role, "dialog"); assert.equal(first.modal, "true");
    assert.equal(first.labelled, SLIDES[0][0], "named by the slide's own title");
    assert.equal(first.kicker, "What's new in DGC 0.52");
    assert.deepEqual([first.title, first.text], SLIDES[0]);
    assert.deepEqual([first.dots, first.at, first.step], [6, 0, "1 of 6"]);
    assert.deepEqual(first.buttons, ["Skip", "Next"]);
    assert.equal(first.focus, "Next", "the keyboard starts on Next");
    assert.ok(first.picture.bottom <= first.box.top + first.box.height / 2 + 40, "the picture is on top");
    const scenes = [first.scene];
    for (let i = 1; i < 6; i++) {
      await x.page.click("#whats-new .wn-next");
      const s = await now(x.page);
      assert.deepEqual([s.title, s.text], SLIDES[i], `slide ${i + 1}`);
      assert.deepEqual([s.at, s.step], [i, `${i + 1} of 6`]);
      assert.deepEqual(s.buttons, i < 5 ? ["Skip", "Next"] : ["Done"], i < 5 ? "Skip and Next" : "the last slide: Done, and nothing to skip");
      scenes.push(s.scene);
    }
    assert.deepEqual(scenes, ["pips-list", "wall", "levels", "cards", "work", "settings"], "each slide has its own picture");
    assert.deepEqual(await seen(x), [], "nothing is remembered until it is answered");
    await x.page.click("#whats-new .wn-next");                      // Done
    assert.equal(await now(x.page), null);
    assert.deepEqual(await seen(x), [{ type: "whatsNewSeen" }]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("slide 6 is a list: Your Browser and payments are left out until they ship, and come back in their place when they do", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open();
  try {
    const also = await x.page.evaluate(() => ({ now: window.DgcWhatsNew.alsoNew(), all: window.DgcWhatsNew.alsoNew(["browser", "payments"]) }));
    assert.equal(also.now, SLIDES[5][1]);
    assert.doesNotMatch(also.now, /Browser|payment/i);
    assert.equal(also.all, "Change settings by asking. A fallback model on every surface. Your Browser, where you sign in once for your Pips. Daily payment limits in dollars. Incognito chats.");
  } finally { await x.close(); }
});

test("Skip and Esc close it for good; the arrow keys move; a click outside does not answer for you", async (t) => {
  if (skipOrFail(t)) return;
  let x = await open();
  try {
    await x.page.keyboard.press("ArrowRight"); await x.page.keyboard.press("ArrowRight");
    assert.equal((await now(x.page)).title, SLIDES[2][0]);
    await x.page.keyboard.press("ArrowLeft");
    assert.equal((await now(x.page)).title, SLIDES[1][0]);
    for (let i = 0; i < 9; i++) await x.page.keyboard.press("ArrowLeft");
    assert.equal((await now(x.page)).at, 0, "it stops at the first");
    for (let i = 0; i < 9; i++) await x.page.keyboard.press("ArrowRight");
    assert.deepEqual([(await now(x.page)).at, (await now(x.page)).buttons], [5, ["Done"]], "and at the last, which never closes by an arrow");
    // A dot goes straight to its slide.
    await x.page.click("#whats-new .wn-dot >> nth=3");
    assert.equal((await now(x.page)).title, SLIDES[3][0]);
    await x.page.mouse.click(4, 4);
    assert.ok(await now(x.page), "a stray click on the page behind doesn't close it");
    assert.deepEqual(await seen(x), []);
    await x.page.keyboard.press("Escape");
    assert.equal(await now(x.page), null);
    assert.deepEqual(await seen(x), [{ type: "whatsNewSeen" }]);
  } finally { await x.close(); }
  x = await open();
  try {
    await x.page.click("#whats-new .wn-skip");
    assert.equal(await now(x.page), null);
    assert.deepEqual(await seen(x), [{ type: "whatsNewSeen" }]);
    // Tab stays inside while it is open, and the page behind gets the keyboard back when it goes.
    await x.send({ type: "whatsNew", auto: false, release: "0.52" });
    await x.page.waitForSelector("#whats-new:not([hidden])");
    assert.equal((await now(x.page)).at, 0, "opened again from the menu, from the first slide");
    for (let i = 0; i < 12; i++) { await x.page.keyboard.press("Tab"); assert.equal(await x.page.evaluate(() => !!document.activeElement?.closest("#whats-new")), true, `Tab ${i + 1} stays in the dialog`); }
    await x.page.keyboard.press("Escape");
    assert.equal(await now(x.page), null);
    assert.equal((await seen(x)).length, 2);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("300 px and 700 px, dark, light and high contrast: it fits the side bar, the picture is 16:9 and drawn in the page, the buttons are the 6 px family", async (t) => {
  if (skipOrFail(t)) return;
  for (const theme of ["dark-modern", "light-modern", "hc"]) for (const width of [300, 700]) {
    const x = await open({ width, theme, height: width === 300 ? 640 : 760 });
    try {
      for (let i = 0; i < 6; i++) {
        const s = await now(x.page), where = `${theme} ${width} slide ${i + 1}`;
        assert.equal(s.overflowX, false, `${where}: no sideways scroll`);
        assert.ok(s.box.left >= 0 && s.box.right <= s.width + 0.5 && s.box.top >= 0 && s.box.bottom <= s.height + 0.5, `${where}: the dialog is inside the side bar`);
        assert.ok(Math.abs(s.picture.width / s.picture.height - 16 / 9) < 0.02, `${where}: 16:9 (${s.picture.width}×${s.picture.height})`);
        assert.equal(s.images, 0, `${where}: no image file, the picture is drawn in the page`);
        assert.ok(s.drawn >= 6, `${where}: a picture, not a blank box`);
        assert.equal(s.clipped, 0, `${where}: nothing of the picture pokes out of its frame`);
        for (const shape of s.shapes) assert.equal(shape, "6px 28", `${where}: a button of the one family (6 px corners, 28 px high)`);
        assert.ok(s.textFits, `${where}: the words are all reachable`);
        if (i < 5) await x.page.click("#whats-new .wn-next");
      }
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});
