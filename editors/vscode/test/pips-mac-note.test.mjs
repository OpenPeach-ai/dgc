// The Mac dialog (0.52; pips-sandbox-design §6, agreed 13 Nov): once, only on a Mac whose Pips can't have their own
// computer (get_pip_runner's runner.boxes.available is false, Pips API 96): "Pips' own computers need a Mac with Apple
// silicon on macOS 26. Until then, folder Pips can only read their folder, and Your Browser runs as a separate Chrome
// profile on this Mac (less walled off than a computer). A Pip can still use your own Chrome when you allow it." with
// OK. Never on other machines; never again after OK or Esc (the editor's global state, which every window shares).
// Not in the same launch as What's new or the Pips welcome: only one thing opens by itself per launch.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DgcViewProvider, cleanup, extensionRoot } from "./support/panel-bundle.mjs";
import { makeDom } from "./support/webview-dom.mjs";

const pid = (c) => "pip_" + c.repeat(32);
const KEY = "dgc.pipsMacNoteSeen", NEWS = "dgc.whatsNewSeen", WELCOME_KEY = "dgc.pipsWelcomeSeen";
const NO_BOXES = { available: false, why: "Pips' own computers need macOS 26 on Apple silicon." }, BOXES = { available: true, why: "" };
const MOVED = { had_pips: true, folders: [], personal: [{ id: pid("b"), name: "Mornings" }], do_it_all: [] }, NEW_USER = { had_pips: false, folders: [], personal: [], do_it_all: [] };
const SAYS = ["Pips’ own computers need a Mac with Apple silicon on macOS 26.",
  "Until then, folder Pips can only read their folder, and Your Browser runs as a separate Chrome profile on this Mac (less walled off than a computer). A Pip can still use your own Chrome when you allow it."];

// ---- the host: when it shows, and that it never shows again -------------------------------------------------------------

const made = [];
after(() => { for (const p of made) { try { p.dispose(); } catch { /* already gone */ } } cleanup(); });
function memory(initial = {}) { const kept = new Map(Object.entries(initial)); return { kept, get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, v); } }; }
/** A window's side bar on `platform`, with a DGC whose runner says `boxes` (an Error: it doesn't answer). */
function provider(globalState, { platform = "darwin", boxes = NO_BOXES, api = 96, welcome = NEW_USER, tab = false, connected = true } = {}) {
  const context = { extension: { packageJSON: JSON.parse(readFileSync(`${extensionRoot}/package.json`, "utf8")) }, extensionUri: { fsPath: "/ext" }, subscriptions: [],
    secrets: { async get() {}, async store() {}, async delete() {} }, globalState, workspaceState: { get() {}, async update() {} } };
  const places = { current: () => undefined, open: () => undefined, openSessions: () => new Set(), changed() {} };
  const p = tab ? new DgcViewProvider(context, { key: "0123456789abcdef", session: "", places, host: provider(globalState).p, title() {}, restored: false }) : new DgcViewProvider(context);
  made.push(p);
  const posted = [], dgc = { api, boxes, welcome, connected, reads: 0 };
  p.post = (m) => { posted.push(m); };
  p.webviewReady = true;
  p.ensureBackend = () => ({ ready: false, send() { return false; }, sendSetup() { return false; }, request: async () => ({}), dispose() {} });
  if (!tab) { p.places = places; p.home = true; }
  p.hostPlatform = () => platform;
  const bridge = { flowReady: () => dgc.connected && dgc.api >= 96,
    welcome: async () => { if (!dgc.connected || dgc.api < 96) throw new Error("Update DGC."); return dgc.welcome; },
    boxes: async () => { dgc.reads++; if (!dgc.connected || dgc.api < 96) throw new Error("Update DGC."); if (dgc.boxes instanceof Error) throw dgc.boxes; return dgc.boxes; },
    receive() {}, attach() {}, ready() {}, offline() {}, event: () => false, dispose() {} };
  p.pipsEditor = bridge;
  p.ensurePipsBridge = () => bridge;
  return { p, posted, dgc, shown: () => posted.filter((m) => m.type === "pipsMacNote"), welcomes: () => posted.filter((m) => m.type === "pipsWelcome"), open: () => p.onMessage({ type: "pipsTabOpened" }) };
}
const SEEN = { [NEWS]: "0.52", [WELCOME_KEY]: "0.52" };

test("shown once, by itself, when the Pips tab opens on a Mac whose Pips can't have their own computer; OK is remembered for every window", async () => {
  const state = memory(SEEN);
  const side = provider(state);
  await side.open();
  assert.deepEqual(side.shown(), [{ type: "pipsMacNote" }]);
  assert.equal(state.kept.get(KEY), undefined, "nothing is remembered until it is answered");
  await side.p.onMessage({ type: "pipsMacNoteSeen" });
  assert.equal(state.kept.get(KEY), true);
  await side.open();
  assert.equal(side.shown().length, 1, "never again in this window");
  const other = provider(state);
  await other.open();
  assert.deepEqual(other.shown(), [], "nor in another window, or at a later launch");
  assert.equal(other.dgc.reads, 0, "and DGC is not even asked");
});

test("never on other machines, and never on a Mac whose Pips have their own computer", async () => {
  for (const platform of ["linux", "win32"]) {
    const side = provider(memory(SEEN), { platform });
    await side.open();
    assert.deepEqual(side.shown(), [], platform);
    assert.equal(side.dgc.reads, 0, platform + ": DGC is not asked");
  }
  const mac = provider(memory(SEEN), { boxes: BOXES });
  await mac.open(); await mac.open();
  assert.deepEqual(mac.shown(), []);
  assert.equal(mac.dgc.reads, 1, "asked once in a launch");
  assert.equal(mac.p.context.globalState.get(KEY), undefined, "and nothing is remembered: a Mac that loses its boxes later is still told");
});

test("only what DGC says: an answer that is not runner.boxes shows nothing; a DGC that doesn't answer is asked again next time", async () => {
  for (const boxes of [null, {}, { available: "no" }, { available: 0, why: "x" }, "false", []]) {
    const side = provider(memory(SEEN), { boxes });
    await side.open();
    assert.deepEqual(side.shown(), [], JSON.stringify(boxes));
  }
  const flaky = provider(memory(SEEN), { boxes: new Error("No reply from DGC.") });
  await flaky.open();
  assert.deepEqual(flaky.shown(), []);
  flaky.dgc.boxes = NO_BOXES;
  await flaky.open();
  assert.equal(flaky.shown().length, 1);
  const old = provider(memory(SEEN), { api: 95 });
  await old.open();
  assert.deepEqual(old.shown(), [], "an older DGC says nothing about boxes");
  assert.equal(old.dgc.reads, 0);
  const tab = provider(memory(SEEN), { tab: true });
  await tab.open();
  assert.deepEqual(tab.shown(), [], "a session's tab is not the side bar");
});

test("only one thing opens by itself per launch: not after What's new, and not after the Pips welcome", async () => {
  const state = memory();
  const first = provider(state, { welcome: MOVED });
  first.p.offerWhatsNew();
  assert.equal(first.posted.filter((m) => m.type === "whatsNew").length, 1, "What's new opened by itself");
  await first.open();
  assert.deepEqual(first.shown(), [], "so the Mac dialog waits");
  await first.p.onMessage({ type: "whatsNewSeen" });
  await first.open();
  assert.deepEqual(first.shown(), [], "for the whole launch, answered or not");
  const second = provider(state, { welcome: MOVED });               // the next launch: the Pips welcome is the one thing
  second.p.offerWhatsNew();
  await second.open();
  assert.equal(second.welcomes().length, 1, "the welcome");
  assert.deepEqual(second.shown(), []);
  await second.p.onMessage({ type: "pipsWelcomeSeen" });
  await second.open();
  assert.deepEqual(second.shown(), [], "not in the launch the welcome opened in");
  const third = provider(state, { welcome: MOVED });                // the launch after that
  third.p.offerWhatsNew();
  await third.open();
  assert.deepEqual(third.welcomes(), []);
  assert.equal(third.shown().length, 1, "now the Mac dialog");
});

test("the Mac dialog showing keeps the Pips welcome for a later launch; left unanswered, it comes again at the next visit", async () => {
  const state = memory({ [NEWS]: "0.52" });
  const side = provider(state, { welcome: new Error("No reply from DGC.") });
  side.p.pipsEditor.welcome = async () => { if (side.dgc.welcome instanceof Error) throw side.dgc.welcome; return side.dgc.welcome; };
  await side.open();
  assert.equal(side.shown().length, 1, "the welcome couldn't be read, so the Mac dialog is the one thing");
  side.dgc.welcome = MOVED;
  await side.p.onMessage({ type: "pipsTabClosed" });
  await side.open();
  assert.deepEqual(side.welcomes(), [], "the welcome waits for another launch");
  assert.equal(side.shown().length, 2, "and the unanswered dialog comes again");
});

test("the Pips tab opened before DGC was up: shown as soon as it is, while the tab is still open", async () => {
  const side = provider(memory(SEEN), { connected: false });
  await side.open();
  assert.deepEqual(side.shown(), []);
  side.dgc.connected = true;
  await side.p.pipsBridgeReady();
  assert.equal(side.shown().length, 1);
});

// ---- the page (jsdom): what it says, and what closes it -----------------------------------------------------------------

function page() {
  const s = makeDom({});
  s.dom.window.DgcPips = { mount: () => ({ navigate() {}, setVisible() {}, setFocused() {} }) };
  s.layer = () => { const l = s.doc.getElementById("pips-mac-note"); return l && !l.hidden ? l : null; };
  s.of = (type) => JSON.parse(JSON.stringify(s.posted.filter((m) => m.type === type)));
  s.openTab = () => s.send({ type: "pipsOpen" });
  s.note = () => s.send({ type: "pipsMacNote" });
  return s;
}
const words = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();

test("the words, as agreed, and one button: OK", () => {
  const s = page();
  s.openTab(); s.note();
  const layer = s.layer();
  assert.ok(layer, "the dialog");
  assert.equal(layer.getAttribute("role"), "dialog"); assert.equal(layer.getAttribute("aria-modal"), "true");
  assert.equal(words(s.doc.getElementById(layer.getAttribute("aria-labelledby"))), SAYS[0], "its first sentence is its title");
  assert.equal(words(layer.querySelector(".pw-lead")), SAYS[1]);
  assert.deepEqual([...layer.querySelectorAll(".pw-dialog *")].map((n) => n.tagName), ["DIV", "H2", "P", "DIV", "BUTTON"], "nothing else in it");
  assert.deepEqual([...layer.querySelectorAll("button")].map((b) => [b.textContent.trim(), b.className]), [["OK", "pw-got dgc-btn primary"]]);
  assert.equal(s.doc.activeElement, layer.querySelector("button"), "OK has the focus");
  assert.doesNotMatch(words(layer), /\bAI\b/);
  assert.deepEqual(s.errors, []);
});

test("OK and Esc each close it for good; a click on it or beside it leaves it open", () => {
  for (const how of ["ok", "esc"]) {
    const s = page();
    s.openTab(); s.note();
    const layer = s.layer();
    layer.querySelector(".pw-lead").click();
    layer.dispatchEvent(new s.dom.window.MouseEvent("click", { bubbles: true }));
    assert.ok(s.layer(), "a notice shown once is not lost to a stray click");
    assert.deepEqual(s.of("pipsMacNoteSeen"), []);
    if (how === "ok") layer.querySelector("button").click();
    else s.doc.dispatchEvent(new s.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(s.layer(), null, how);
    assert.deepEqual(s.of("pipsMacNoteSeen"), [{ type: "pipsMacNoteSeen" }], how);
  }
});

test("it opens only over the Pips tab, and leaving the tab closes it unanswered", () => {
  const away = page();
  away.note();
  assert.equal(away.layer(), null, "the tab was left before DGC answered: it waits for the next visit");
  const s = page();
  s.openTab(); s.note();
  assert.ok(s.layer());
  s.doc.getElementById("btn-pips-back").click();
  assert.equal(s.layer(), null);
  assert.deepEqual(s.of("pipsMacNoteSeen"), [], "not answered: it comes again");
});
