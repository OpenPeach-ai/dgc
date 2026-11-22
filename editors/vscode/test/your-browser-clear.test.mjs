// Clear browsing data in Your Browser (Pips API 112), measured in real Chromium on the real side bar:
//   - a right-click on Your Browser in the dock offers "Clear browsing data…" (with DGC that has it, where it can run);
//   - ONE dialog: "Clear browsing data", three checkboxes each with one plain line of what it removes (Browsing history
//     ticked, Sign-ins and Saved passwords not); the button names what it does ("Clear history", "Clear 2 kinds of
//     data"), off with none ticked; Cancel and Escape close it and nothing is asked; the button asks DGC for exactly
//     what was ticked; honest notes (it closes and opens again where it runs; signed in to Chrome, the account keeps
//     its own copy); one design language (6 px corners, button heights) at 300, 440 and 700 px in both themes;
//   - the editor's bridge (src/pipsView.ts) lets clear_your_browser through with those fields only, never to an older DGC.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, dockNow } from "./support/dock-scene.mjs";
import { homeState } from "./support/home-scene.mjs";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";

const PICTURES = process.env.DGC_YB_PICTURES || "";
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

const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000 });
const requests = (page, type) => page.evaluate((t) => window.__requests.filter((r) => r.type === t), type);
const ready = (recent = {}) => ({ ...homeState(), browser: { recent: { links: [{ url: "https://news.example.org/", title: "News", host: "news.example.org" }], open: false, available: true, reason: "", install: null, ...recent } } });
async function sideBar(width, theme, recent, api = 112) {
  const x = await openDock(browser, { width, height: 760, theme, api, state: ready(recent) });
  await waitFor(x.page, () => /Your Browser/.test(document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]')?.getAttribute("aria-label") || ""));
  return x;
}
async function menu(x) {
  const tile = (await dockNow(x.page)).items.find((i) => i.key === "browser");
  await x.page.mouse.click(tile.left + tile.width / 2, tile.top + tile.height / 2, { button: "right" });
  await waitFor(x.page, () => document.querySelectorAll(".dgc-pop .dgc-menu-row").length > 0);
  return (await dockNow(x.page)).menu;
}
async function openClear(x) {
  await menu(x);
  await x.page.evaluate(() => [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].find((r) => /Clear browsing data/.test(r.textContent)).click());
  await waitFor(x.page, () => !!document.querySelector("dialog.yb-clear-dialog[open]"));
}
const dialogNow = (page) => page.evaluate(() => {
  const d = document.querySelector("dialog.yb-clear-dialog");
  if (!d) return null;
  const r = d.getBoundingClientRect();
  return { title: d.querySelector("h2").textContent,
    kinds: [...d.querySelectorAll(".yb-clear-kind")].map((k) => ({ name: k.querySelector(".yb-clear-name").textContent, line: k.querySelector(".yb-clear-line").textContent, on: k.querySelector("input").checked, kind: k.querySelector("input").name })),
    notes: [...d.querySelectorAll(".yb-clear-note")].map((n) => n.textContent),
    buttons: [...d.querySelectorAll(".new-session-buttons button")].map((b) => ({ text: b.textContent.trim(), disabled: b.disabled, radius: getComputedStyle(b).borderTopLeftRadius, height: b.getBoundingClientRect().height })),
    rows: [...d.querySelectorAll(".yb-clear-kind")].map((k) => ({ radius: getComputedStyle(k).borderTopLeftRadius, right: k.getBoundingClientRect().right })),
    left: r.left, right: r.right, top: r.top, bottom: r.bottom, focus: document.activeElement?.name || document.activeElement?.textContent?.trim(),
    overflow: document.documentElement.scrollWidth > innerWidth || d.scrollWidth > d.clientWidth + 1, error: d.querySelector(".yb-clear-error").hidden ? "" : d.querySelector(".yb-clear-error").textContent };
});

test("right-click on Your Browser offers Clear browsing data, which opens one dialog with the three kinds", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(440, "dark-modern");
  try {
    assert.deepEqual(await menu(x), ["Open Your Browser", "Clear browsing data…"]);
    await x.page.keyboard.press("Escape");
    await openClear(x);
    const d = await dialogNow(x.page);
    assert.equal(d.title, "Clear browsing data");
    assert.deepEqual(d.kinds.map((k) => [k.name, k.on]), [["Browsing history", true], ["Sign-ins", false], ["Saved passwords", false]]);
    assert.match(d.kinds[0].line, /Pages you visited, the downloads list and the recent links on Home’s Browser card/);
    assert.match(d.kinds[1].line, /Cookies and site data: you’ll be signed out of sites/);
    assert.match(d.kinds[2].line, /Passwords Chrome saved in Your Browser/);
    assert.deepEqual(d.buttons.map((b) => [b.text, b.disabled]), [["Cancel", false], ["Clear history", false]]);
    assert.equal(d.focus, "history", "the first box has the keys");
    assert.deepEqual(d.notes, [], "closed, and Chrome not signed in to an account: nothing more to say");
  } finally { await x.close(); }
});

test("the button says what it clears, and is off with nothing ticked", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(440, "light-modern");
  try {
    await openClear(x);
    const click = (kind) => x.page.click(`dialog.yb-clear-dialog input[name="${kind}"]`);
    const button = async () => (await dialogNow(x.page)).buttons[1];
    await click("sign_ins");
    assert.deepEqual(await button().then((b) => [b.text, b.disabled]), ["Clear 2 kinds of data", false]);
    await click("passwords");
    assert.equal((await button()).text, "Clear 3 kinds of data");
    await click("history"); await click("sign_ins");
    assert.equal((await button()).text, "Clear passwords");
    await click("passwords");
    assert.deepEqual(await button().then((b) => [b.text, b.disabled]), ["Clear", true]);
    await click("sign_ins");
    assert.equal((await button()).text, "Clear sign-ins");
    // The label is the box: a click on a kind's words ticks it too.
    await x.page.click('dialog.yb-clear-dialog .yb-clear-kind:has(input[name="history"]) .yb-clear-line');
    assert.equal((await button()).text, "Clear 2 kinds of data");
  } finally { await x.close(); }
});

test("Cancel and Escape close it, and nothing is asked", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(440, "dark-modern");
  try {
    await openClear(x);
    await x.page.click("dialog.yb-clear-dialog .yb-clear-cancel");
    assert.equal(await dialogNow(x.page), null);
    await openClear(x);
    await x.page.keyboard.press("Escape");
    assert.equal(await dialogNow(x.page), null);
    assert.deepEqual(await requests(x.page, "clear_your_browser"), [], "nothing is cleared before the button");
  } finally { await x.close(); }
});

test("the button asks DGC for exactly what was ticked, then says what was cleared", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(440, "dark-modern");
  try {
    await openClear(x);
    await x.page.click('dialog.yb-clear-dialog input[name="sign_ins"]');
    const asked = (await requests(x.page, "get_your_browser_recent")).length;
    await x.page.click("dialog.yb-clear-dialog .yb-clear-go");
    await waitFor(x.page, () => window.__requests.some((r) => r.type === "clear_your_browser"));
    assert.deepEqual((await requests(x.page, "clear_your_browser"))[0], { type: "clear_your_browser", history: true, sign_ins: true, passwords: false });
    await waitFor(x.page, () => !document.querySelector("dialog.yb-clear-dialog"));
    await waitFor(x.page, () => /Cleared: browsing history, sign-ins\./.test(document.querySelector("#dgc-dock .dgc-dock-tip")?.textContent || ""));
    await waitFor(x.page, (n) => window.__requests.filter((r) => r.type === "get_your_browser_recent").length > n, asked);
  } finally { await x.close(); }
});

test("a refusal is said in the dialog, which stays with its boxes as they were", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(440, "light-modern");
  try {
    await x.page.evaluate(() => { window.__state.browser.clearRefuse = "Your Browser is still open on this computer. Close it, then clear again."; });
    await openClear(x);
    await x.page.click("dialog.yb-clear-dialog .yb-clear-go");
    await waitFor(x.page, () => !document.querySelector("dialog.yb-clear-dialog .yb-clear-error").hidden);
    const d = await dialogNow(x.page);
    assert.match(d.error, /still open on this computer/);
    assert.deepEqual(d.buttons.map((b) => [b.text, b.disabled]), [["Cancel", false], ["Clear history", false]]);
    assert.equal(d.kinds[0].on, true);
  } finally { await x.close(); }
});

test("honest notes: open, it closes and opens again; signed in to Chrome, the account keeps its own copy", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(440, "dark-modern", { open: true, chrome_account: true });
  try {
    await openClear(x);
    assert.deepEqual((await dialogNow(x.page)).notes, ["Your Browser closes for a moment and opens again.",
      "Chrome is signed in to a Google account in Your Browser: if its sync is on, your account keeps its own copy."]);
  } finally { await x.close(); }
});

test("an older DGC, or Your Browser needing Google Chrome, offers no Clear", async (t) => {
  if (skipOrFail(t)) return;
  let x = await sideBar(440, "dark-modern", {}, 111);
  try { assert.deepEqual(await menu(x), ["Open Your Browser"]); } finally { await x.close(); }
  x = await sideBar(440, "dark-modern", { available: false, reason: "Your Browser runs in Google Chrome, which isn't on this computer yet.", install: { how: "password", state: "", error: "", line: "" } });
  try { assert.deepEqual(await menu(x), ["Install Google Chrome…"]); } finally { await x.close(); }
});

for (const width of [300, 440, 700]) {
  for (const theme of ["dark-modern", "light-modern"]) {
    test(`the dialog at ${width} px, ${theme}: inside the page, the one corner, the buttons' height`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await sideBar(width, theme, { open: true, chrome_account: true });
      try {
        await openClear(x);
        const d = await dialogNow(x.page);
        assert.ok(d.left >= 8 && d.right <= width - 8, `inside the side bar (${d.left}..${d.right} of ${width})`);
        assert.ok(d.top >= 0 && d.bottom <= 760, "inside the page's height");
        assert.equal(d.overflow, false, "nothing runs off sideways");
        for (const b of d.buttons) { assert.equal(b.radius, "6px"); assert.ok(b.height >= 24 && b.height <= 32, `${b.text}: a button's height (${b.height})`); }
        for (const r of d.rows) { assert.equal(r.radius, "6px"); assert.ok(r.right <= d.right, "each kind inside the dialog"); }
        if (PICTURES) await x.page.screenshot({ path: `${PICTURES}/clear-dialog-${width}-${theme.startsWith("dark") ? "dark" : "light"}.png` });
      } finally { await x.close(); }
    });
  }
}

// ---- the editor's bridge ------------------------------------------------------------------------------------------------
const viewModule = await pipsViewModule();
const vscode = { ViewColumn: { Active: -1, Beside: -2 }, Uri: { joinPath: (...p) => ({ path: p.map((x) => x.path || x).join("/") }), file: (p) => ({ path: p }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, f) => f }) }, window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }) } };
function bridge(api) {
  const { PipsEditor } = viewModule(vscode);
  const page = [], sent = [];
  const editor = new PipsEditor({ path: "ext" }, (m) => { sent.push(m); return true; }, () => {}, true);
  editor.attach((m) => page.push(m));
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
  editor.receive({ type: "pipsReady" });
  const generation = page.filter((m) => m.type === "pipsConnection").at(-1).generation;
  return { ask: (id, request) => editor.receive({ type: "pipsRequest", id, generation, request }), controls: () => sent.filter((m) => m.type === "pips_control").map((m) => m.request), replies: () => page.filter((m) => m.type === "pipsReply") };
}

test("the bridge lets Clear browsing data through with what was ticked only, and never to an older DGC", () => {
  const b = bridge(112);
  b.ask("r1", { type: "clear_your_browser", history: true, sign_ins: false, passwords: true });
  b.ask("r2", { type: "clear_your_browser", history: "yes" });
  b.ask("r3", { type: "clear_your_browser", history: true, cache: true });
  b.ask("r4", { type: "clear_your_browser", history: false, sign_ins: false, passwords: false });
  b.ask("r5", { type: "clear_your_browser", pip_id: "pip_" + "a".repeat(32), history: true });
  const sent = b.controls();
  assert.deepEqual(sent.map((r) => ({ ...r, request_id: undefined })), [{ type: "clear_your_browser", history: true, sign_ins: false, passwords: true, request_id: undefined }]);
  assert.deepEqual(b.replies().map((m) => m.error?.message), ["Your Browser can't be asked that from here.", "Your Browser can't be asked that from here.", "Choose what to clear.", "Your Browser can't be asked that from here."]);
  const older = bridge(111);
  older.ask("r1", { type: "clear_your_browser", history: true });
  assert.deepEqual(older.controls(), []);
  assert.deepEqual(older.replies().map((m) => m.error?.message), ["Update DGC to clear Your Browser's data."]);
});
