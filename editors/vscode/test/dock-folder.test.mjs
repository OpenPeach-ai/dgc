// A Work folder on the dock (asked 13 Nov: "how can i Pin a folder directory on to the dock?"). A folder is pinned from
// a Project Folder dropdown's row and from a Folders card's tile (the dropdown's first line that pinned the chosen folder went on 14 Nov: each row's own pin does it); on the dock it is his folder icon
// in the folder's own kept palette with the folder's name on its label, still unless something in it runs; a click
// opens Work on that folder; its menu has New work here, Open in new window and Unpin; it shows in every window; a
// folder that is gone is dimmed and says "Not found". The host's side (src/dock.ts, bundled against a stub `vscode`)
// first, then the page in real Chromium on the real side bar.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { openDock, dockNow, DOCK_SESSIONS, PINS } from "./support/dock-scene.mjs";
import { openGrid, FOLDERS } from "./support/home-grid-scene.mjs";

const root = new URL("..", import.meta.url).pathname;
let window_ = "/home/me/shop";
globalThis.__DOCKF_VSCODE = {
  ConfigurationTarget: { Global: 1 },
  Uri: { joinPath: (base, ...parts) => ({ fsPath: [base.fsPath, ...parts].join("/") }), parse: (text) => ({ toString: () => text }) },
  workspace: { get workspaceFolders() { return [{ uri: { fsPath: window_ } }]; }, getConfiguration: () => ({ get: (_k, fallback) => fallback, update: async () => {} }), onDidChangeConfiguration: () => ({ dispose() {} }) },
  window: { showQuickPick: async () => undefined, onDidChangeWindowState: () => ({ dispose() {} }) },
};
const out = await build({ entryPoints: [root + "src/dock.ts"], bundle: true, write: false, format: "cjs", platform: "node",
  plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
    b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.__DOCKF_VSCODE;" })); } }] });
const mod = { exports: {} };
new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, (await import("node:module")).createRequire(import.meta.url));
const { Dock } = mod.exports;
const store = () => { const kept = new Map(); return { globalState: { get: (k) => kept.get(k), update: async (k, v) => { kept.set(k, JSON.parse(JSON.stringify(v))); } }, kept }; };
const scratch = mkdtempSync(join(tmpdir(), "dgc-dock-folder-"));
after(() => { delete globalThis.__DOCKF_VSCODE; rmSync(scratch, { recursive: true, force: true }); });

test("the host keeps a pinned folder: in every window, across a reload, with its path; one that is gone is said to be", async () => {
  const here = join(scratch, "garden-notes"), gone = join(scratch, "old-site");
  mkdirSync(here);
  const context = store(), dock = new Dock(context);
  assert.equal(await dock.pin({ kind: "folder", id: "f1x2y3z", title: "garden-notes", ref: { folder: here } }), true);
  assert.equal(await dock.pin({ kind: "folder", id: "f9old", title: "old-site", ref: { folder: gone } }), true);
  const pins = dock.state().pins;
  assert.deepEqual(pins.map((p) => [p.key, p.kind, p.title, p.ref.folder, p.gone === true]), [["folder:f1x2y3z", "folder", "garden-notes", here, false], ["folder:f9old", "folder", "old-site", gone, true]]);
  // Another window, in another folder, after a reload: it is there (a way to reach a folder, not one window's thing).
  window_ = "/home/me/elsewhere";
  assert.deepEqual(new Dock(context).state().pins.map((p) => p.key), ["folder:f1x2y3z", "folder:f9old"], "it shows in every window");
  window_ = "/home/me/shop";
  // A folder pin without a real path is not a pin; the folder's palette is kept as a folder's is.
  assert.equal(await dock.pin({ kind: "folder", id: "fbad", title: "x", ref: {} }), false);
  assert.equal(await dock.pin({ kind: "folder", id: "fbad", title: "x", ref: { folder: "relative/path" } }), false);
  assert.equal(dock.pins().length, 2);
  dock.handle({ type: "dockToggle", item: { kind: "folder", id: "f1x2y3z", title: "garden-notes", ref: { folder: here } } }); await new Promise((d) => setTimeout(d, 10));
  assert.deepEqual(new Dock(context).pins().map((p) => p.key), ["folder:f9old"], "a second press unpins");
  await dock.unpin("folder:f9old");
  assert.deepEqual(new Dock(context).pins(), []);
});

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
const GARDEN = "/home/me/garden-notes", SHOP = "/home/me/shop", OLD = "/home/me/old-site";
const folderId = (p, folder) => p.evaluate((f) => window.DgcFolderPick.folderId(f), folder);
const pinOf = async (p, folder, name) => ({ key: `folder:${await folderId(p, folder)}`, kind: "folder", id: await folderId(p, folder), title: name, sub: "", look: {}, ref: { folder } });
const withFolders = async (x, choice = "", more = {}) => { await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", folders: { ...FOLDERS, choice }, ...more }); await x.settle(); };
/** How opaque a thing is once its fade has come to rest (1: shown; it is given two seconds to get there). */
const shown = (locator) => locator.evaluate((n) => new Promise((done) => { const t0 = performance.now(); (function look() { const o = Number(getComputedStyle(n).opacity); if (o === 1 || performance.now() - t0 > 2000) done(o); else requestAnimationFrame(look); })(); }));
const folderPins = (x) => x.page.evaluate(() => window.__dock.pins.filter((p) => p.kind === "folder").map((p) => [p.title, p.ref.folder]));

test("pin from the Project Folder dropdown: a pin shows on a folder's row when it is pointed at; a click pins it and chooses nothing", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 460, pins: [] });
  try {
    const p = x.page;
    await withFolders(x);
    await p.click("#sessions-folder-pick"); await x.settle();
    // (Since 14 Nov a row's pin is a button of its own beside the row's, not a span inside it: the keyboard reaches it.)
    const row = p.locator(`.dgc-folder-menu .dgc-folder-row[data-folder="${GARDEN}"]`), pin = p.locator(`.dgc-folder-menu .dgc-folder-pin[data-folder-pin="${GARDEN}"]`);
    assert.equal(await p.locator('.dgc-folder-menu .dgc-folder-pin[data-folder-pin=""]').count(), 0, "All projects is not a folder: no pin");
    assert.equal(await p.locator(".dgc-folder-menu .dgc-folder-pin").count(), 4, "one for each folder that is there");
    assert.equal(Number(await pin.evaluate((n) => getComputedStyle(n).opacity)), 0, "at rest the row is as it was");
    await row.hover(); await x.settle();
    assert.equal(await shown(pin), 1, "pointed at: its pin shows");
    assert.equal(await pin.getAttribute("aria-pressed"), "false"); assert.match(await pin.getAttribute("title"), /Pin to the dock/);
    assert.ok(parseFloat(await pin.evaluate((n) => getComputedStyle(n).borderTopLeftRadius)) <= 6, "the one corner");
    await pin.click(); await x.settle();
    assert.deepEqual(await folderPins(x), [["garden-notes", GARDEN]], "the folder is pinned, by its name and its path");
    assert.equal((await x.posted("projectFolderChoose")).length, 0, "pinning chooses no folder");
    assert.equal(await p.locator(".dgc-folder-menu").count(), 1, "and the menu stays open");
    assert.equal(await pin.getAttribute("aria-pressed"), "true", "its pin is filled now");
    await p.mouse.move(2, 2); await x.settle();
    assert.equal(await shown(pin), 1, "and stays in sight while pinned, pointed at or not");
    const item = (await dockNow(p)).items.find((i) => i.kind === "folder");
    assert.ok(item, "it is on the dock"); assert.match(item.label, /^garden-notes/);
    await pin.click(); await x.settle();
    assert.deepEqual(await folderPins(x), [], "a second click unpins");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("pin from a Folders card tile; on the Work page the Project Folder menu has no line of its own to pin the chosen folder", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 460, layout: ["folders"], pins: [] });
  try {
    const p = x.page, tile = p.locator('.hc-card[data-card="folders"] .hc-tile[data-name="rust_ire"]'), pin = tile.locator(".hc-pin");
    assert.equal(Number(await pin.evaluate((n) => getComputedStyle(n).opacity)), 0);
    await tile.hover(); await x.rest();
    assert.equal(await shown(pin), 1, "pointed at: the tile's pin shows beside New work here");
    assert.equal(await pin.getAttribute("aria-label"), "Pin to the dock: rust_ire");
    await pin.click(); await x.rest(200);
    assert.deepEqual(await folderPins(x), [["rust_ire", "/home/me/rust_ire"]]);
    assert.equal(await pin.getAttribute("aria-pressed"), "true");
    assert.equal((await x.posted("projectFolderChoose")).length, 0, "the tile was not opened");
    assert.equal(await p.locator('.hc-card[data-card="folders"] .hc-tile.hc-gone .hc-pin').count(), 0, "a folder that is gone has no pin to offer");
    // The Work page (changed 14 Nov: the menu's first line that pinned the chosen folder is gone; each row's own pin does
    // it, and the keyboard reaches that pin with Right from its row): no button of its own beside the dropdown either.
    await p.click("#side-tab-work"); await x.rest(200);
    assert.equal(await p.locator("#sessions-folder-pin").count(), 0, "no pin button on the Library row: the dropdown ends it, as before");
    await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", folders: { ...FOLDERS, choice: GARDEN } }); await x.rest(200);
    await p.focus("#sessions-folder-pick"); await p.keyboard.press("ArrowDown"); await x.rest(700);
    assert.equal(await p.locator(".dgc-folder-menu [data-folder-pin-line]").count(), 0, "no first line to pin the chosen folder");
    assert.equal(await p.evaluate(() => document.querySelector(".dgc-folder-menu .dgc-menu-row")?.dataset.folder), "", "the menu starts with All projects");
    // By the keyboard: Down opened the menu on the folder chosen; Right goes to its pin; Enter pins, and again unpins.
    await p.keyboard.press("ArrowRight"); await x.rest(80);
    assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Pin to the dock: garden-notes", "the keyboard reaches the row's pin");
    await p.keyboard.press("Enter"); await x.rest(300);
    assert.deepEqual(await folderPins(x), [["rust_ire", "/home/me/rust_ire"], ["garden-notes", GARDEN]]);
    assert.equal((await x.posted("projectFolderChoose")).length, 0, "pinning chooses nothing");
    assert.equal(await p.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Unpin from the dock: garden-notes", "the pin says what it does now, and the menu is still open");
    await p.keyboard.press("Enter"); await x.rest(300);
    assert.deepEqual(await folderPins(x), [["rust_ire", "/home/me/rust_ire"]], "and it unpins");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  test(`${theme}: a pinned folder on the dock is its folder icon in its own palette with its name on the label, still unless something in it runs`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openDock(browser, { width: 460, theme, pins: [] });
    try {
      const p = x.page;
      await withFolders(x);
      const garden = await pinOf(p, GARDEN, "garden-notes"), shop = await pinOf(p, SHOP, "shop"), old = { ...(await pinOf(p, OLD, "old-site")), gone: true };
      await x.setting({ pins: [garden, shop, old], colours: { [garden.key]: "fern", [shop.key]: "azure" } }); await x.settle();
      const tiles = await p.evaluate(() => [...document.querySelectorAll('#dgc-dock .dgc-dock-item[data-kind="folder"]')].map((b) => { const icon = b.querySelector(".folder-icon"), tile = b.querySelector(".dgc-dock-tile").getBoundingClientRect(), r = icon?.getBoundingClientRect();
        return { label: b.getAttribute("aria-label"), palette: [...(icon?.classList || [])].find((c) => c.startsWith("folder--")) || "", name: icon?.querySelector(".folder-label")?.textContent || "", inside: !!r && r.left >= tile.left - 1 && r.right <= tile.right + 1 && r.top >= tile.top - 1 && r.bottom <= tile.bottom + 1,
          moving: [...b.querySelectorAll("*")].some((n) => n.getAnimations().some((a) => a.playState === "running")), gone: b.dataset.gone === "1", opacity: Number(getComputedStyle(b.querySelector(".dgc-dock-tile")).opacity), dot: b.querySelector(".dgc-dock-dot")?.dataset.dot || "" }; }));
      assert.deepEqual(tiles.map((t) => [t.palette, t.name]), [["folder--fern", "garden-notes"], ["folder--azure", "shop"], [tiles[2].palette, "old-site"]], "his folder icon, in the folder's kept palette, its name on the label");
      assert.ok(tiles.every((t) => t.inside), "the icon fits its tile");
      assert.deepEqual(tiles.map((t) => t.moving), [false, false, false], "still at rest");
      assert.match(tiles[0].label, /^garden-notes\. Folder · 6 sessions/); assert.match(tiles[1].label, /^shop\. .*14 sessions · 1 Pip.*this window/i);
      assert.equal(tiles[2].gone, true); assert.match(tiles[2].label, /Not found/); assert.ok(tiles[2].opacity < 0.7, "a folder that is gone is dimmed");
      assert.ok(tiles[0].opacity === 1 && tiles[0].gone === false);
      // Something in it runs: the running dot (the scene's first session runs; here it is said to be in garden-notes).
      await withFolders(x, "", { items: DOCK_SESSIONS.map((s, k) => (k === 0 ? { ...s, projectPath: GARDEN, projectName: "garden-notes" } : s)) });
      const live = await p.evaluate(() => document.querySelector('#dgc-dock .dgc-dock-item[data-kind="folder"] .dgc-dock-dot')?.dataset.dot || "");
      assert.equal(live, "live", "while a session in it runs, its tile says so");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("a click on a pinned folder opens the Work tab on that folder; its menu: New work here, Open in new window, Unpin; a gone folder opens nothing", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openDock(browser, { width: 460, pins: [], tab: "home" });
  try {
    const p = x.page;
    await withFolders(x);
    const garden = await pinOf(p, GARDEN, "garden-notes"), old = { ...(await pinOf(p, OLD, "old-site")), gone: true };
    await x.setting({ pins: [garden, old, ...PINS.slice(3, 4)] }); await x.settle();
    const tile = p.locator(`#dgc-dock .dgc-dock-item[data-key="${garden.key}"]`);
    await tile.click(); await x.settle();
    assert.deepEqual((await x.posted("projectFolderChoose")).at(-1), { type: "projectFolderChoose", folder: GARDEN }, "the Project Folder is set to it");
    assert.equal(await p.getAttribute("#side-tab-work", "aria-selected"), "true", "and the Work tab is in front");
    assert.equal((await x.posted("dockOpen")).length, 0, "the page opens it itself: there is no editor tab to open");
    await tile.click({ button: "right" }); await x.settle();
    const menu = (await dockNow(p)).menu;
    assert.deepEqual(menu.slice(0, 3), ["New work here", "Open in new window", "Unpin"]);
    await p.locator(".dgc-pop .dgc-menu-row", { hasText: "New work here" }).click(); await x.settle();
    assert.deepEqual((await x.posted("newSessionInEditor")).at(-1), { type: "newSessionInEditor", folder: GARDEN });
    await tile.click({ button: "right" }); await x.settle();
    await p.locator(".dgc-pop .dgc-menu-row", { hasText: "Open in new window" }).click(); await x.settle();
    assert.deepEqual((await x.posted("folderOpenWindow")).at(-1), { type: "folderOpenWindow", folder: GARDEN });
    // A folder that is gone: a click opens nothing, and its menu offers only Unpin of the three.
    const before = (await x.posted("projectFolderChoose")).length;
    const goneTile = p.locator(`#dgc-dock .dgc-dock-item[data-key="${old.key}"]`);
    await goneTile.click(); await x.settle();
    assert.equal((await x.posted("projectFolderChoose")).length, before, "a gone folder opens nothing");
    await goneTile.click({ button: "right" }); await x.settle();
    assert.deepEqual((await dockNow(p)).menu.slice(0, 3), ["New work here (off)", "Open in new window (off)", "Unpin"]);
    await p.locator(".dgc-pop .dgc-menu-row", { hasText: "Unpin" }).click(); await x.settle();
    assert.deepEqual(await folderPins(x), [["garden-notes", GARDEN]], "Unpin takes it off the dock");
    // By the keyboard: Enter opens, as every dock item.
    await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", folders: { ...FOLDERS, choice: "" } }); await p.click("#side-tab-home"); await x.settle();
    await tile.focus(); await p.keyboard.press("Enter"); await x.settle();
    assert.equal(await p.getAttribute("#side-tab-work", "aria-selected"), "true");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
