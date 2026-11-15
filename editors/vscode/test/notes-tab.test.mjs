// Notes, step 5 (src/notesTab.ts, media/shared/notestab.js): a note open wide in an editor tab. The same editor at the
// full width, on the same store, so a change in the tab is in the card and a change in the card is in the tab. The tab's
// document is built by the real code against a stub `vscode`; its page runs in real Chromium beside the side bar's.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { openGrid } from "./support/home-grid-scene.mjs";
import { sample } from "./support/notes-sample.mjs";
import { cleanup, notesModule, context, seed, ask } from "./support/notes-host.mjs";
import { openNoteTab, tabModule } from "./support/notes-tab-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); cleanup(); });
const CARD = '.hc-grid .hc-card[data-card="note"]', OPEN = ".hc-open .hc-card";

test("the tab's document: scripts and styles from the extension only, no inline script, and the note it is for", async () => {
  const { noteTabDocument } = await tabModule();
  const html = noteTabDocument((name) => `vscode-resource://ext/media/${name}`, "vscode-resource://ext", "ferry1");
  assert.match(html, /<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src vscode-resource:\/\/ext; script-src vscode-resource:\/\/ext;">/);
  assert.equal(/<script(?![^>]*\ssrc=)[^>]*>/.test(html), false, "no inline script"); assert.equal(/\son[a-z]+=|style="/.test(html), false, "no inline handlers or styles");
  assert.match(html, /<body[^>]* data-note="ferry1"/);
  assert.deepEqual([...html.matchAll(/(?:src|href)="vscode-resource:\/\/ext\/media\/([^"]+)"/g)].map((m) => m[1]), ["shared/tokens.css", "shared/menu.css", "shared/homecards.css", "shared/notes.css", "shared/tip.css", "shared/menu.js", "shared/tip.js", "shared/notes.js", "shared/notestab.js"]);
  assert.equal(noteTabDocument((n) => n, "x", '"><script>alert(1)</script>').includes("<script>alert"), false, "a note id is never markup");
});

test("NoteTabs: one tab a note, titled by the note; its messages go to the notes' store and it hears what the store says; closing it lets go", async () => {
  const { NoteTabs } = await tabModule(), { Notes } = await notesModule();
  const c = await seed(context(), sample()), notes = new Notes(c), panels = [];
  Object.assign(globalThis.__NOTES_VSCODE.window, { createWebviewPanel: (type, title, column, options) => { const panel = { type, title, column, options, revealed: 0, posted: [], closed: [], webview: { html: "", cspSource: "csp", asWebviewUri: (u) => `uri:${u.path}`, onDidReceiveMessage: (f) => { panel.receive = f; return { dispose() {} }; }, postMessage: (m) => { panel.posted.push(m); return Promise.resolve(true); } },
    reveal: () => { panel.revealed++; }, onDidDispose: (f) => { panel.closed.push(f); return { dispose() {} }; }, dispose: () => { for (const f of panel.closed) f(); } }; panels.push(panel); return panel; }, registerWebviewPanelSerializer: () => ({ dispose() {} }) });
  Object.assign(globalThis.__NOTES_VSCODE.ViewColumn, { Active: -1 }); Object.assign(globalThis.__NOTES_VSCODE.Uri, { joinPath: (base, ...parts) => ({ path: [base.path, ...parts].join("/") }) });
  const tabs = new NoteTabs({ extensionUri: { path: "/ext" } }, notes);
  await ask(notes, { type: "homeNotesDo", op: "get" });
  tabs.open("ferry1");
  assert.equal(panels.length, 1); assert.deepEqual([panels[0].type, panels[0].title, panels[0].options.enableScripts], ["dgc.noteTab", "Ferry to Porto", true]);
  assert.deepEqual(panels[0].options.localResourceRoots.map((u) => u.path), ["/ext/media"]);
  assert.match(panels[0].webview.html, / data-note="ferry1"/); assert.match(panels[0].webview.html, /uri:\/ext\/media\/shared\/notes\.js/);
  tabs.open("ferry1"); assert.equal(panels.length, 1, "the same note: its tab comes forward"); assert.equal(panels[0].revealed, 1);
  tabs.open("nosuch"); assert.equal(panels.length, 1, "no tab for a note there is not");
  // The page's messages are the store's; what the store says reaches the tab; the tab's title follows the note's.
  panels[0].receive({ type: "homeNotesDo", op: "save", id: "ferry1", text: "Ferry to Lisbon\nA new plan" }); await notes.idle();
  assert.ok(panels[0].posted.some((m) => m.type === "homeNotes")); assert.equal(panels[0].title, "Ferry to Lisbon");
  panels[0].receive({ type: "somethingElse" }); await notes.idle();
  const before = panels[0].posted.length; panels[0].dispose();
  await ask(notes, { type: "homeNotesDo", op: "pin", id: "ferry1", on: false });
  assert.equal(panels[0].posted.length, before, "a closed tab hears no more");
  tabs.open("ferry1"); assert.equal(panels.length, 2, "and the note can be opened in a tab again");
});

test("a note in its tab: the same editor at the full width; what is typed in the tab is in the card, and what is typed in the card is in the tab", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openGrid(browser, { width: 700, layout: ["note", "clock"], seed: sample() }), p = x.page;
  const tab = await openNoteTab(browser, x.notes.store, "ferry1", { width: 1100 }), q = tab.page;
  try {
    const look = await q.evaluate(() => { const d = document.querySelector(".nt-doc"), r = d.getBoundingClientRect(), bar = [...document.querySelectorAll(".nt-format button[data-cmd]")].map((b) => b.dataset.cmd);
      return { lines: d.querySelectorAll(":scope > .nt-l").length, bold: d.querySelector("b")?.textContent, width: r.width, bar, list: document.querySelectorAll(".hc-note-row, .nt-rail, input.hc-note-find").length, tools: [...document.querySelectorAll(".hc-note-tools button")].map((b) => b.getAttribute("aria-label") || b.textContent), over: document.documentElement.scrollWidth > innerWidth,
        ground: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(d).color }; });
    assert.equal(look.lines, 14); assert.equal(look.bold, "north quay"); assert.ok(look.width > 560 && look.width <= 780, `a readable column at the tab's width (${look.width})`);
    assert.deepEqual(look.bar, ["bold", "italic", "heading", "ul", "ol", "ck", "link", "undo"]); assert.equal(look.list, 0, "the note alone: no list, no folders, no search"); assert.equal(look.over, false);
    assert.ok(look.tools.some((w) => /Unpin this note/.test(w)) && look.tools.some((w) => /Lock this note/.test(w)) && look.tools.some((w) => /More for this note/.test(w)));
    assert.notEqual(look.ground, look.ink);
    // Typed in the tab: kept, and the card's open note follows.
    await q.click(".nt-doc"); await q.keyboard.press("Control+End"); await q.keyboard.press("Enter"); await q.keyboard.type("Bring coins for the café"); await tab.rest(1000); await x.rest(400);
    assert.match(await x.notes.text("ferry1"), /\n- Bring coins for the café$/);
    assert.match(await p.locator(`${CARD} .nt-doc`).innerText(), /Bring coins for the café/, "the card shows what the tab wrote");
    // Typed in the card: the tab follows.
    await p.click(`${CARD} .nt-doc`); await p.keyboard.press("Control+Home"); await p.keyboard.press("End"); await p.keyboard.type(", in May"); await x.rest(1000); await tab.rest(400);
    assert.equal(await q.evaluate(() => document.querySelector(".nt-doc > .nt-l").textContent), "Ferry to Porto, in May");
    assert.equal(await q.title(), "Ferry to Porto, in May");
    // Deleted from its ⋯ menu: the tab says so and offers Undo.
    await q.click(".nt-more"); await tab.rest(150);
    assert.deepEqual(await q.locator(".nt-menu .dgc-menu-label").allInnerTexts(), ["Move to a folder…", "Duplicate", "Export as Markdown…", "Copy text", "Copy as Markdown", "Delete"], "everything the card's menu has, but the tab itself");
    await q.locator(".nt-menu .dgc-menu-row", { hasText: "Delete" }).click(); await tab.rest(400);
    assert.match(await q.locator("body").innerText(), /This note is in Recently deleted/); assert.equal(await q.locator(".nt-doc").count(), 0);
    await q.click(".nt-tab-restore"); await tab.rest(400);
    assert.equal(await q.locator(".nt-doc").count(), 1); assert.equal((await x.notes.list()).some((n) => n.id === "ferry1"), true);
  } finally { await tab.close(); await x.close(); }
});

test("in the card: ⋯ has Duplicate, Open in an editor tab, Export and Copy; Ctrl+D duplicates; a folder exports from the folder menu", async (t) => {
  if (skipOrFail(t)) return;
  const calls = { clip: [], save: [], folder: [], tab: [] }, env = { clipboard: (text) => { calls.clip.push(text); }, saveFile: async (f) => { calls.save.push(f); return true; }, saveFolder: async (f) => { calls.folder.push(f); return f.name; }, openTab: (id) => { calls.tab.push(id); } };
  const x = await openGrid(browser, { width: 300, layout: ["note", "clock"], seed: sample(), notesOptions: { env } }), p = x.page;
  try {
    await p.click(`${CARD} .nt-openapp`); await x.rest(200); await p.click(`${OPEN} .hc-note-row[data-note="seeds1"]`); await x.rest(300);
    await p.click(`${OPEN} .nt-more`); await x.rest(150);
    assert.deepEqual(await p.locator(".nt-menu .dgc-menu-label").allInnerTexts(), ["Move to a folder…", "Duplicate", "Open in an editor tab", "Export as Markdown…", "Copy text", "Copy as Markdown", "Delete"]);
    const pick = async (label) => { if (!(await p.locator(".nt-menu").count())) { await p.click(`${OPEN} .nt-more`); await x.rest(150); } await p.locator(".nt-menu .dgc-menu-row", { hasText: label }).first().click(); await x.rest(300); };
    await pick("Open in an editor tab"); assert.deepEqual(calls.tab, ["seeds1"]);
    await pick("Export as Markdown…"); assert.deepEqual(calls.save, [{ name: "Seeds for spring.md", text: "Seeds for spring\nTomatoes, basil, sweet peas", locked: false }]);
    assert.match(await p.locator(".hc-live").innerText(), /Exported/);
    await pick("Copy as Markdown"); await pick("Copy text"); assert.deepEqual(calls.clip, ["Seeds for spring\nTomatoes, basil, sweet peas", "Seeds for spring\nTomatoes, basil, sweet peas"]);
    await pick("Duplicate");
    let all = await x.notes.list(); assert.equal(all.filter((n) => n.title === "Seeds for spring").length, 2);
    const copy = all.find((n) => n.title === "Seeds for spring" && n.id !== "seeds1");
    assert.equal(await p.evaluate(() => document.querySelector(".hc-open .nt-doc")?.textContent.includes("Tomatoes")), true, "the copy is the note that is open now");
    await p.click(`${OPEN} .nt-doc`); await p.keyboard.press("Control+End"); await p.keyboard.type(" and dill"); await x.rest(900);
    assert.match(await x.notes.text(copy.id), /and dill$/); assert.equal(await x.notes.text("seeds1"), "Seeds for spring\nTomatoes, basil, sweet peas", "the first is as it was");
    await p.keyboard.press("Control+d"); await x.rest(400);
    assert.equal((await x.notes.list()).filter((n) => n.title === "Seeds for spring").length, 3, "Ctrl+D in a note duplicates it");
    // A whole folder, from the folder menu.
    await p.keyboard.press("Escape"); await x.rest(200);
    await p.click(`${OPEN} .nt-folder`); await x.rest(150); await p.locator(".nt-menu .dgc-menu-row", { hasText: "Reading" }).click(); await x.rest(250);
    await p.click(`${OPEN} .nt-folder`); await x.rest(150); await p.locator(".nt-menu .dgc-menu-row", { hasText: "Export Reading…" }).click(); await x.rest(300);
    assert.deepEqual([calls.folder[0].name, calls.folder[0].files.map((f) => f.name)], ["Reading", ["Book club the March pick.md", "Reading list.md", "Lines I liked.md"]]);
    assert.match(await p.locator(".hc-live").innerText(), /3 notes exported to the folder Reading/);
  } finally { await x.close(); }
});
