// "Your Pips moved into one list" (0.52; pips-flow-design §3.3, item 2, picture 11): the pop-up the Pips tab shows once,
// the first time it opens with a DGC at Pips API 96, only for someone whose Pips came from 0.51 (get_pips_welcome's
// had_pips). It names the user's own Pips: the ones that were Project Pips, by folder, the Personal ones, and the ones
// that were on Do it all. Got it, Esc or a click outside closes it for good, kept in the editor's global state as
// What's new is (src/pipsWelcome.ts), so every window agrees. Only one thing opens by itself per launch: What's new
// first. Pips settings has "How Pips work now", which opens it again. A Pip's name in it opens that Pip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DgcViewProvider, cleanup, extensionRoot } from "./support/panel-bundle.mjs";
import { makeDom } from "./support/webview-dom.mjs";
import { openHome } from "./support/home-scene.mjs";
import { setup as openPips } from "./support/one-pips-node.mjs";

const pid = (c) => "pip_" + c.repeat(32), ws = (c) => "ws_" + c.repeat(32);
const GST = { id: pid("c"), name: "GST watchdog" }, ERP = { id: pid("d"), name: "ERP daily audit" }, MORNINGS = { id: pid("b"), name: "Mornings" }, GARDEN = { id: pid("e"), name: "Garden notes" };
const WELCOME = { had_pips: true, folders: [{ workspace_id: ws("4"), folder: "lime_tiles", pips: [GST, ERP] }], personal: [MORNINGS, GARDEN], do_it_all: [MORNINGS] };
/** What the page is told of it: ids and names, a folder by its name. */
const TOLD = { had_pips: true, folders: [{ folder: "lime_tiles", pips: [GST, ERP] }], personal: [MORNINGS, GARDEN], do_it_all: [MORNINGS] };
const NEW_USER = { had_pips: false, folders: [], personal: [], do_it_all: [] };
const KEY = "dgc.pipsWelcomeSeen", NEWS = "dgc.whatsNewSeen";

// ---- the host: when it shows, and that it never shows again -------------------------------------------------------------

const made = [];
after(() => { for (const p of made) { try { p.dispose(); } catch { /* already gone */ } } cleanup(); });
function memory(initial = {}) { const kept = new Map(Object.entries(initial)); return { kept, get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, v); } }; }
/** A window's side bar. `dgc`: what its DGC is (api, and what get_pips_welcome answers; a function is asked each time). */
function provider(globalState, { home = true, tab = false, api = 96, welcome = WELCOME, connected = true } = {}) {
  const context = { extension: { packageJSON: JSON.parse(readFileSync(`${extensionRoot}/package.json`, "utf8")) }, extensionUri: { fsPath: "/ext" }, subscriptions: [],
    secrets: { async get() {}, async store() {}, async delete() {} }, globalState, workspaceState: { get() {}, async update() {} } };
  const places = { current: () => undefined, open: () => undefined, openSessions: () => new Set(), changed() {} };
  const p = tab ? new DgcViewProvider(context, { key: "0123456789abcdef", session: "", places, host: provider(globalState).p, title() {}, restored: false }) : new DgcViewProvider(context);
  made.push(p);
  const posted = [], dgc = { api, welcome, connected, reads: 0 };
  p.post = (m) => { posted.push(m); };
  p.webviewReady = true;
  p.ensureBackend = () => ({ ready: false, send() { return false; }, sendSetup() { return false; }, request: async () => ({}), dispose() {} });
  if (home && !tab) { p.places = places; p.home = true; }
  // The Pips bridge, as far as the welcome uses it: whether this DGC has the flow (API 96), and the one read.
  const bridge = { flowReady: () => dgc.connected && dgc.api >= 96,
    welcome: async () => { dgc.reads++; if (!dgc.connected || dgc.api < 96) throw new Error("Update DGC."); const w = typeof dgc.welcome === "function" ? dgc.welcome() : dgc.welcome; if (w instanceof Error) throw w; return w; },
    receive() {}, attach() {}, ready() {}, offline() {}, event: () => false, dispose() {} };
  p.pipsEditor = bridge;
  p.ensurePipsBridge = () => bridge;
  return { p, posted, dgc, shown: () => posted.filter((m) => m.type === "pipsWelcome"), open: () => p.onMessage({ type: "pipsTabOpened" }) };
}

test("shown once, by itself, the first time the Pips tab opens: with the user's own Pips, as DGC names them", async () => {
  const state = memory({ [NEWS]: "0.52" });
  const side = provider(state);
  await side.open();
  assert.deepEqual(side.shown(), [{ type: "pipsWelcome", auto: true, welcome: TOLD }]);
  assert.equal(state.kept.get(KEY), undefined, "nothing is remembered until it is answered");
  await side.p.onMessage({ type: "pipsWelcomeSeen" });
  assert.equal(state.kept.get(KEY), "0.52");
  await side.open();
  assert.equal(side.shown().length, 1, "never again in this window");
  const other = provider(state);
  await other.open();
  assert.deepEqual(other.shown(), [], "nor in another window of this editor");
  assert.equal(other.dgc.reads, 0, "and DGC is not even asked");
});

test("only for someone who had Pips: a new user never sees it, and nothing is remembered for them", async () => {
  const state = memory({ [NEWS]: "0.52" });
  const side = provider(state, { welcome: NEW_USER });
  await side.open();
  assert.deepEqual(side.shown(), []);
  assert.equal(state.kept.get(KEY), undefined);
  await side.open(); await side.open();
  assert.equal(side.dgc.reads, 1, "DGC is asked once in a launch, not at every visit to the tab");
});

test("only with a DGC at API 96; a session's tab never shows it; a DGC that doesn't answer shows nothing and is asked again next time", async () => {
  const old = provider(memory({ [NEWS]: "0.52" }), { api: 95 });
  await old.open();
  assert.deepEqual(old.shown(), []);
  assert.equal(old.dgc.reads, 0, "an older DGC is never asked");
  const tab = provider(memory({ [NEWS]: "0.52" }), { tab: true });
  await tab.open();
  assert.deepEqual(tab.shown(), [], "a tab is not the side bar");
  const flaky = provider(memory({ [NEWS]: "0.52" }), { welcome: new Error("No reply from DGC.") });
  await flaky.open();
  assert.deepEqual(flaky.shown(), []);
  flaky.dgc.welcome = WELCOME;
  await flaky.open();
  assert.equal(flaky.shown().length, 1);
});

test("the Pips tab opened before DGC was up: shown as soon as it is, while the tab is still open, and not after it was left", async () => {
  const side = provider(memory({ [NEWS]: "0.52" }), { connected: false });
  await side.open();
  assert.deepEqual(side.shown(), []);
  side.dgc.connected = true;
  await side.p.pipsBridgeReady();
  assert.equal(side.shown().length, 1);
  const left = provider(memory({ [NEWS]: "0.52" }), { connected: false });
  await left.open();
  await left.p.onMessage({ type: "pipsTabClosed" });
  left.dgc.connected = true;
  await left.p.pipsBridgeReady();
  assert.deepEqual(left.shown(), [], "it waits for the next visit to the tab");
});

test("only one thing opens by itself per launch: What's new first, the Pips pop-up at a later launch", async () => {
  const state = memory();
  const first = provider(state);
  first.p.offerWhatsNew();
  assert.equal(first.posted.filter((m) => m.type === "whatsNew").length, 1, "What's new opened by itself");
  await first.open();
  assert.deepEqual(first.shown(), [], "so the Pips pop-up waits");
  await first.p.onMessage({ type: "whatsNewSeen" });
  await first.open();
  assert.deepEqual(first.shown(), [], "for the whole launch, answered or not");
  assert.equal(first.dgc.reads, 0);
  const later = provider(state);                                   // a later launch: What's new was answered
  later.p.offerWhatsNew();
  assert.equal(later.posted.filter((m) => m.type === "whatsNew").length, 0);
  await later.open();
  assert.equal(later.shown().length, 1);
});

test("How Pips work now (Pips settings) opens it again whenever asked: seen or not, and even right after What's new", async () => {
  const state = memory({ [KEY]: "0.52" });
  const side = provider(state);
  side.p.offerWhatsNew();
  await side.p.onMessage({ type: "pipsWelcomeOpen" });
  assert.deepEqual(side.shown(), [{ type: "pipsWelcome", auto: false, welcome: TOLD }]);
  const fresh = provider(memory({ [NEWS]: "0.52" }), { welcome: NEW_USER });
  await fresh.p.onMessage({ type: "pipsWelcomeOpen" });
  assert.deepEqual(fresh.shown(), [{ type: "pipsWelcome", auto: false, welcome: NEW_USER }], "someone with nothing moved is told how Pips work, without a list");
  const old = provider(memory(), { api: 95 });
  await old.p.onMessage({ type: "pipsWelcomeOpen" });
  assert.deepEqual(old.shown(), [], "not offered below API 96");
});

test("what DGC answers is checked before the page is told: only real Pip ids, names as text of a sane length, bounded lists", async () => {
  const messy = { had_pips: true, extra: "x",
    folders: [{ workspace_id: ws("4"), folder: "lime_tiles", path: "/home/me/code/lime_tiles", pips: [GST, { id: "pip_nope", name: "Bad id" }, { id: pid("f"), name: "  " }, { id: pid("9"), name: "x".repeat(500) }] },
      { workspace_id: ws("5"), folder: "empty", pips: [] }, "junk", { folder: 7, pips: [ERP] }],
    personal: [MORNINGS, null, { id: pid("b"), name: "Mornings again" }], do_it_all: "no" };
  const side = provider(memory({ [NEWS]: "0.52" }), { welcome: messy });
  await side.open();
  const [told] = side.shown();
  assert.deepEqual(told.welcome.folders.map((f) => [f.folder, f.pips.map((p) => p.name.length)]), [["lime_tiles", [12, 120]], ["", [15]]], "a folder with no Pips is left out; a name is cut at 120");
  assert.deepEqual(told.welcome.personal, [MORNINGS], "a Pip is named once");
  assert.deepEqual(told.welcome.do_it_all, []);
  assert.deepEqual(Object.keys(told.welcome).sort(), ["do_it_all", "folders", "had_pips", "personal"]);
  const none = provider(memory({ [NEWS]: "0.52" }), { welcome: { had_pips: "yes", folders: [], personal: [], do_it_all: [] } });
  await none.open();
  assert.deepEqual(none.shown(), [], "had_pips must be DGC's own true");
});

// ---- the page (jsdom): what it says, what closes it, what a name does ---------------------------------------------------

function page(place) {
  const s = makeDom(place ? { place } : {});
  s.navigated = [];
  s.dom.window.DgcPips = { mount: (options) => { s.pipsOptions = options; return { navigate: (value) => s.navigated.push(value), setVisible() {}, setFocused() {} }; } };
  s.layer = () => { const l = s.doc.getElementById("pips-welcome"); return l && !l.hidden ? l : null; };
  s.of = (type) => JSON.parse(JSON.stringify(s.posted.filter((m) => m.type === type)));
  s.openTab = () => s.send({ type: "pipsOpen" });
  s.welcome = (welcome = TOLD, auto = true) => s.send({ type: "pipsWelcome", auto, welcome });
  return s;
}
const words = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
const rows = (layer) => [...layer.querySelectorAll(".pw-row")].map((r) => [words(r.querySelector(".pw-names")), words(r.querySelector(".pw-says"))]);

test("the page tells the editor each time the Pips tab opens, and when it is left", () => {
  const s = page();
  s.openTab();
  assert.deepEqual(s.of("pipsTabOpened"), [{ type: "pipsTabOpened" }]);
  s.openTab();
  assert.equal(s.of("pipsTabOpened").length, 1, "already open: not a new visit");
  s.doc.getElementById("btn-pips-back").click();
  assert.deepEqual(s.of("pipsTabClosed"), [{ type: "pipsTabClosed" }]);
  s.openTab();
  assert.equal(s.of("pipsTabOpened").length, 2);
});

test("the words: the title, nothing was lost, each folder's Pips, the Personal ones, what is different, and who was on Do it all", () => {
  const s = page();
  s.openTab(); s.welcome();
  const layer = s.layer();
  assert.ok(layer, "the pop-up");
  assert.equal(layer.getAttribute("role"), "dialog"); assert.equal(layer.getAttribute("aria-modal"), "true");
  assert.equal(words(s.doc.getElementById(layer.getAttribute("aria-labelledby"))), "Your Pips moved into one list");
  assert.equal(words(layer.querySelector(".pw-lead")), "Nothing was lost. Every Pip kept its name, its job, its schedule and its history.");
  assert.deepEqual(rows(layer), [
    ["GST watchdog · ERP daily audit", "Were Project Pips in lime_tiles. Now each has its own computer and reads your files as they are, not only what is committed."],
    ["Mornings · Garden notes", "Were Personal Pips. Nothing changes for them."],
    ["What is different", "A Pip now tells you what it finds in its own chat, not in a Work session. What needs you is on Home and under Needs you here. All your Pips start at Ask me first."],
    ["Mornings", "was on Do it all. It keeps what that meant before; choose Do it all again to let it do more."],
  ]);
  assert.equal(words(layer.querySelector(".pw-full")), "Mornings was on Do it all. It keeps what that meant before; choose Do it all again to let it do more.", "read as one sentence");
  assert.deepEqual([...layer.querySelectorAll(".pw-foot button")].map((b) => b.textContent.trim()), ["How Pips work now", "Got it"]);
  assert.equal(layer.querySelectorAll("img, picture, video, canvas").length, 0);
  assert.deepEqual(s.errors, []);
});

test("names and counts are the user's own: one Pip in the singular, more than three as \"A, B and N more\", a group with none left out", () => {
  const many = { had_pips: true, folders: [
    { folder: "lime_tiles", pips: [GST, ERP, { id: pid("1"), name: "Night tests" }, { id: pid("2"), name: "Docs check" }, { id: pid("3"), name: "Lock review" }, { id: pid("4"), name: "Stock count" }] },
    { folder: "garden", pips: [{ id: pid("5"), name: "Bed planner" }] }], personal: [], do_it_all: [] };
  const s = page();
  s.openTab(); s.welcome(many);
  assert.deepEqual(rows(s.layer()), [
    ["GST watchdog, ERP daily audit and 4 more", "Were Project Pips in lime_tiles. Now each has its own computer and reads your files as they are, not only what is committed."],
    ["Bed planner", "Was a Project Pip in garden. Now it has its own computer and reads your files as they are, not only what is committed."],
    ["What is different", "A Pip now tells you what it finds in its own chat, not in a Work session. What needs you is on Home and under Needs you here. All your Pips start at Ask me first."],
  ], "no Personal row, no Do it all row");
  const personal = page();
  personal.openTab(); personal.welcome({ had_pips: true, folders: [], personal: [MORNINGS], do_it_all: [MORNINGS, GARDEN] });
  assert.deepEqual(rows(personal.layer()).map((r) => r[0] + " | " + r[1].split(".")[0]), ["Mornings | Was a Personal Pip", "What is different | A Pip now tells you what it finds in its own chat, not in a Work session", "Mornings and Garden notes | were on Do it all"]);
  assert.match(rows(personal.layer())[2][1], /They keep what that meant before; choose Do it all again to let them do more\.$/);
});

test("Got it, Esc and a click outside each close it for good; a click inside it does not", () => {
  for (const how of ["got", "esc", "outside"]) {
    const s = page();
    s.openTab(); s.welcome();
    const layer = s.layer();
    layer.querySelector(".pw-lead").click();
    assert.ok(s.layer(), "a click on its words leaves it open");
    assert.deepEqual(s.of("pipsWelcomeSeen"), []);
    if (how === "got") layer.querySelector(".pw-got").click();
    else if (how === "esc") s.doc.dispatchEvent(new s.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    else layer.dispatchEvent(new s.dom.window.MouseEvent("click", { bubbles: true }));
    assert.equal(s.layer(), null, how);
    assert.deepEqual(s.of("pipsWelcomeSeen"), [{ type: "pipsWelcomeSeen" }], how);
  }
});

test("a Pip's name in it opens that Pip's chat, and that answers the pop-up too", () => {
  const s = page();
  s.openTab(); s.welcome();
  const name = [...s.layer().querySelectorAll(".pw-pip")].find((b) => b.textContent === "ERP daily audit");
  assert.equal(name.tagName, "BUTTON");
  name.click();
  assert.equal(JSON.stringify(s.navigated), JSON.stringify([{ pip: ERP.id, section: "chat" }]));
  assert.equal(s.layer(), null);
  assert.equal(s.of("pipsWelcomeSeen").length, 1);
});

test("by itself it opens only over the Pips tab; its own How Pips work now keeps it open; opened from settings it is the same pop-up", () => {
  const away = page();
  away.welcome();
  assert.equal(away.layer(), null, "the tab was left before DGC answered: it waits for the next visit");
  assert.deepEqual(away.of("pipsWelcomeSeen"), []);
  const s = page();
  s.openTab(); s.welcome(TOLD, false);
  assert.equal(words(s.layer().querySelector(".pw-title")), "Your Pips moved into one list");
  s.layer().querySelector(".pw-how").click();
  assert.ok(s.layer(), "the pop-up is what it opens, for now");
  assert.deepEqual(s.of("pipsWelcomeSeen"), []);
  const fresh = page();
  fresh.openTab(); fresh.welcome(NEW_USER, false);
  assert.equal(words(fresh.layer().querySelector(".pw-title")), "How Pips work now", "nothing moved for someone who had no Pips");
  assert.equal(fresh.layer().querySelector(".pw-lead"), null);
  assert.deepEqual(rows(fresh.layer()).map((r) => r[0]), ["What is different"]);
});

test("names are text, never markup; a message that is not a welcome draws nothing", () => {
  const s = page();
  s.openTab();
  s.welcome({ had_pips: true, folders: [{ folder: "<b>x</b>", pips: [{ id: pid("1"), name: '<img src=x onerror="1">' }] }], personal: [], do_it_all: [] });
  assert.equal(s.layer().querySelector("img, b"), null);
  assert.equal(rows(s.layer())[0][0], '<img src=x onerror="1">');
  const bad = page();
  bad.openTab(); bad.send({ type: "pipsWelcome", auto: true, welcome: "x" }); bad.send({ type: "pipsWelcome", auto: true });
  assert.equal(bad.layer(), null);
  assert.deepEqual(bad.errors, []);
});

test("the Pips view is given the way to open it again", () => {
  const s = page();
  s.openTab();
  assert.equal(typeof s.pipsOptions.onHowPipsWork, "function");
  s.pipsOptions.onHowPipsWork();
  assert.deepEqual(s.of("pipsWelcomeOpen"), [{ type: "pipsWelcomeOpen" }]);
});

// ---- Pips settings: the line that opens it again -------------------------------------------------------------------------

const windows = [];
after(() => windows.forEach((w) => w.close()));

test("Pips settings has a How Pips work now line at API 96, on every one of its tabs; below 96, or with no way to open it, there is none", async () => {
  let asked = 0;
  const x = openPips({ api: 96, host: { onHowPipsWork: () => { asked++; } } });
  windows.push(x.w);
  await x.drain();
  x.$("#pips-settings-open").click(); await x.drain();
  const line = x.$("#pips-how");
  assert.ok(line, "the line");
  assert.equal(line.tagName, "BUTTON");
  assert.equal(x.squash(line.textContent), "How Pips work now");
  line.click(); await x.drain();
  assert.equal(asked, 1);
  x.$('[data-pips-settings="apps"]').click(); await x.drain();
  assert.ok(x.$("#pips-how"), "on Apps too");
  for (const options of [{ api: 95, host: { onHowPipsWork() {} } }, { api: 96 }]) {
    const old = openPips(options);
    windows.push(old.w);
    await old.drain();
    old.$("#pips-settings-open").click(); await old.drain();
    assert.ok(old.$('.pip-page-tabs[aria-label="Pips settings"]'), "Pips settings is open");
    assert.equal(old.$("#pips-how"), null);
  }
});

// ---- the page, in Chromium: it fits, its buttons are the one family, the keyboard stays in it ----------------------------

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

const now = (p) => p.evaluate(() => {
  const layer = document.getElementById("pips-welcome");
  if (!layer || layer.hidden || !layer.checkVisibility()) return null;
  const box = layer.querySelector(".pw-dialog"), r = (n) => { const b = n.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width, height: b.height }; };
  const got = layer.querySelector(".pw-got"), how = layer.querySelector(".pw-how"), cs = getComputedStyle(got);
  const inside = [...layer.querySelectorAll(".pw-dialog *")].filter((n) => n.getClientRects().length);
  return { box: r(box), width: innerWidth, height: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth,
    got: { ...r(got), radius: cs.borderTopLeftRadius, h: got.offsetHeight }, how: r(how), focus: document.activeElement?.textContent?.trim() || "",
    spill: inside.filter((n) => { const b = n.getBoundingClientRect(), d = box.getBoundingClientRect(); return b.right > d.right + 0.5 || b.left < d.left - 0.5; }).length,
    cut: [...layer.querySelectorAll(".pw-pip, .pw-says, .pw-lead, .pw-title")].filter((n) => n.scrollWidth > n.clientWidth + 1).length,
    pills: [...layer.querySelectorAll("button")].filter((b) => { const q = getComputedStyle(b), h = b.offsetHeight; return h > 0 && parseFloat(q.borderTopLeftRadius) >= h / 2 && b.offsetWidth > h; }).length,
    scrolls: box.scrollHeight > box.clientHeight + 1 ? getComputedStyle(box.querySelector(".pw-body") || box).overflowY : "fits" };
});
const openWelcome = async (options = {}, welcome = TOLD) => {
  const x = await openHome(browser, { width: 300, height: 760, tab: "pips", api: 96, ...options });
  x.page.setDefaultTimeout(10000);
  try {
    await x.send({ type: "pipsOpen" });
    await x.send({ type: "pipsWelcome", auto: true, welcome });
    await x.page.waitForSelector("#pips-welcome:not([hidden])");
  } catch (error) { await x.close(); throw error; }
  return x;
};

test("in the side bar, 300 and 700 px, dark and light: it fits its page, nothing is cut or spills, Got it is the one button shape", async (t) => {
  if (skipOrFail(t)) return;
  for (const [width, theme] of [[300, "dark-modern"], [300, "light-modern"], [700, "dark-modern"], [700, "light-modern"]]) {
    const x = await openWelcome({ width, theme });
    try {
      const s = await now(x.page), at = `${width}px ${theme}`;
      assert.ok(s, at);
      assert.equal(s.overflowX, false, `${at}: no sideways scroll`);
      assert.ok(s.box.left >= 8 && s.box.right <= s.width - 8 && s.box.top >= 0 && s.box.bottom <= s.height, `${at}: inside the page ${JSON.stringify(s.box)}`);
      assert.ok(s.box.width <= 480, `${at}: a pop-up, not a page (${s.box.width})`);
      assert.equal(s.spill, 0, `${at}: nothing spills out of it`);
      assert.equal(s.cut, 0, `${at}: no name or sentence is cut`);
      assert.deepEqual([s.got.radius, s.got.h], ["6px", 28], `${at}: the button family`);
      assert.equal(s.pills, 0, `${at}: never a pill`);
      assert.equal(s.focus, "Got it", `${at}: the keyboard starts on Got it`);
      assert.ok(s.how.right <= s.got.left, `${at}: the link, then Got it`);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
});

test("a long list at 300 px: the pop-up scrolls inside itself and Got it stays in sight", async (t) => {
  if (skipOrFail(t)) return;
  const folders = Array.from({ length: 9 }, (_, i) => ({ folder: `project-${i + 1}-with-a-long-folder-name`, pips: [{ id: pid(String(i)), name: `Watcher number ${i + 1} with a long name` }, { id: pid("abcdef012"[i]), name: "Audit" }] }));
  const x = await openWelcome({ width: 300, height: 520 }, { had_pips: true, folders, personal: [MORNINGS, GARDEN], do_it_all: [MORNINGS] });
  try {
    const s = await now(x.page);
    assert.ok(s.box.bottom <= s.height && s.box.top >= 0, "inside the page");
    assert.ok(s.got.bottom <= s.height && s.got.top >= s.box.top, "Got it is in sight");
    assert.equal(s.spill, 0);
    assert.equal(s.overflowX, false);
  } finally { await x.close(); }
});

test("the keyboard stays in it, Esc closes it for good, and a click outside does too", async (t) => {
  if (skipOrFail(t)) return;
  let x = await openWelcome();
  try {
    const stops = new Set();
    for (let i = 0; i < 12; i++) { await x.page.keyboard.press("Tab"); stops.add(await x.page.evaluate(() => document.activeElement?.closest("#pips-welcome") ? "in" : "out")); }
    assert.deepEqual([...stops], ["in"], "Tab never leaves it");
    await x.page.keyboard.press("Escape");
    assert.equal(await now(x.page), null);
    assert.deepEqual(await x.posted("pipsWelcomeSeen"), [{ type: "pipsWelcomeSeen" }]);
  } finally { await x.close(); }
  x = await openWelcome({ width: 700 });
  try {
    await x.page.mouse.click(8, 400);
    assert.equal(await now(x.page), null, "a click on the page behind it");
    assert.deepEqual(await x.posted("pipsWelcomeSeen"), [{ type: "pipsWelcomeSeen" }]);
  } finally { await x.close(); }
});
