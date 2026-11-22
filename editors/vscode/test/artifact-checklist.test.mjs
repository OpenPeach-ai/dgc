// A checklist (0.52): the artifact DGC makes for a job and keeps current as it works. In real Chromium, with the
// panel's real page (test/support/artifact-scene.mjs) over a checklist as the backend keeps one (artifact-fixture.py):
// it looks like a checklist, not a spreadsheet (a tick box and a status chip an item, what done means, the note, the
// proof with its picture); a tick, a reopen, a status, a changed "done when" and Pin are each one save of the whole
// list with only that change; a save that finds a newer list is made again on it, with no question. The Library lists
// it with its own small sheet and a Checklists kind; Work's list shows the project's pinned checklist with how far
// along it is (the real side bar, test/support/home-scene.mjs); and the extension's side (src/artifacts.ts against a
// stub `vscode`) carries its progress, its save and its rows for Work's list.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { artifactsModule, fixtures, openPanel, panelPage } from "./support/artifact-scene.mjs";
import { openHome } from "./support/home-scene.mjs";
import { openLibraryTab, LIB_ARTIFACTS, SESSION, ar } from "./support/library-scene.mjs";
import { panelHtml, THEMES } from "./support/options-scene.mjs";

// The `vscode` the bundled src/artifacts.ts sees (set before anything bundles it: the bundle reads it once).
const world = { panels: [] };
const uri = (p) => ({ scheme: "file", fsPath: p, path: p, toString: () => `file://${p}` });
globalThis.__DGC_ART_VSCODE = {
  Uri: { file: uri, joinPath: (base, ...parts) => uri([base.fsPath ?? String(base), ...parts].join("/")), parse: (value) => ({ scheme: value.split(":")[0], fsPath: "", path: value, toString: () => value }) },
  ViewColumn: { Active: -1, Beside: -2 },
  window: { createWebviewPanel: (viewType, title) => { const received = [];
    const panel = { viewType, title, webview: { options: {}, html: "", cspSource: "vscode-resource:", posted: [], asWebviewUri: (u) => u, postMessage(m) { this.posted.push(m); return Promise.resolve(true); },
      onDidReceiveMessage: (fn) => { received.push(fn); return { dispose() {} }; } }, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }), reveal() {}, dispose() {},
      say(m) { received.forEach((fn) => fn(m)); }, last(type) { return [...this.webview.posted].reverse().find((m) => m.type === type); } };
    world.panels.push(panel); return panel; },
    registerWebviewPanelSerializer: () => ({ dispose() {} }), showWarningMessage: async () => undefined, showInformationMessage: async () => undefined },
  env: { asExternalUri: async (u) => u, openExternal: async () => true },
  workspace: { workspaceFolders: [{ uri: uri("/home/me/code/shop") }], fs: {} },
  commands: { executeCommand: async () => {} },
};

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser, data;
const skipReason = () => (!chromium ? "playwright is not installed" : !browser ? "Chromium could not start" : !data ? "no Python that imports this checkout's dgc" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  data = fixtures();
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const SHOTS = process.env.DGC_CHECKLIST_SHOTS || "";
const shot = async (page, name) => { if (!SHOTS) return; mkdirSync(SHOTS, { recursive: true }); await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true }); };
const open = (opts = {}) => openPanel(browser, { kind: "checklist", ...opts });
const saves = (s) => s.posted("save");
/** The list as the page shows it. */
const shown = (page) => page.evaluate(() => [...document.querySelectorAll(".ck-item")].map((li) => ({
  id: li.dataset.item, title: li.querySelector(".ck-title").textContent, ticked: li.querySelector(".ck-tick").getAttribute("aria-checked"),
  role: li.querySelector(".ck-tick").getAttribute("role"), chip: li.querySelector(".ck-chip span").textContent, chipStatus: li.querySelector(".ck-chip").dataset.status,
  doneWhen: li.querySelector(".ck-done_when .ck-words")?.textContent ?? null, note: li.querySelector(".ck-note .ck-words")?.textContent ?? null,
  proof: [...li.querySelectorAll(".ck-proof-text")].map((n) => n.textContent), pictures: [...li.querySelectorAll(".ck-pic img")].map((img) => ({ data: img.src.startsWith("data:image/png;base64,"), drawn: img.naturalWidth > 0, alt: img.alt })),
  who: li.querySelector(".ck-who")?.textContent ?? "" })));
/** WCAG contrast of an element's words on the ground actually behind them (its own fill over the page's). */
const contrastOf = (page, selector) => page.evaluate((sel) => {
  const canvas = document.createElement("canvas"); canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const rgba = (value) => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = "#000"; ctx.fillStyle = value; ctx.fillRect(0, 0, 1, 1); const d = ctx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2], d[3] / 255]; };
  const over = (top, under) => { const a = top[3]; return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1); };
  const ground = (node) => { const stack = []; for (let n = node; n; n = n.parentElement) stack.push(rgba(getComputedStyle(n).backgroundColor)); let base = [255, 255, 255, 1]; for (const layer of stack.reverse()) base = over(layer, base); return base; };
  const lum = (c) => { const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }; return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]); };
  return [...document.querySelectorAll(sel)].map((node) => { const bg = ground(node), fg = over(rgba(getComputedStyle(node).color), bg); const a = lum(fg), b = lum(bg);
    return { words: node.textContent.trim().slice(0, 40), ratio: +((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)).toFixed(2) }; });
}, selector);

// ---- the panel ------------------------------------------------------------------------------------------------------------
test("it looks like a checklist: a tick box and a status chip an item, what done means, the note, the proof and its picture", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  try {
    assert.equal(await s.page.evaluate(() => document.getElementById("art-main").dataset.type), "checklist");
    assert.equal(await s.page.evaluate(() => !!document.querySelector("#art-mark .codicon-checklist")), true, "its own mark in the header");
    assert.match(await s.page.evaluate(() => document.getElementById("art-meta").textContent), /^Checklist·version 4/);
    const rows = await shown(s.page);
    assert.deepEqual(rows.map((r) => [r.id, r.title, r.chip, r.ticked]), [["c1", "Write the parser", "Done", "true"], ["c2", "Add the tests", "Building", "false"],
      ["c3", "Publish the package", "Needs you", "false"], ["c4", "Write the README", "Not started", "false"]]);
    assert.ok(rows.every((r) => r.role === "checkbox" && r.chipStatus === r.chip), "a real checkbox, and a chip that says its status");
    assert.equal(rows[0].doneWhen, "parse() reads every sample file in samples/");
    assert.equal(rows[0].note, "Wrote parse() in parser.py; it reads all three samples.");
    assert.deepEqual(rows[0].proof, ["pytest tests/test_parser.py: 4 passed in 0.31s"]);
    assert.deepEqual(rows[0].pictures, [{ data: true, drawn: true, alt: "The run, all three read" }], "the screenshot is drawn from the version's own picture");
    assert.match(rows[0].who, /^Done by DGC/);
    assert.equal(rows[2].note, "The index asks for an API token; I don't have one.");
    assert.equal(rows[3].note, null, "an item not started has no note line yet");
    assert.equal(await s.page.evaluate(() => document.querySelector(".ck-sum").textContent), "1 of 4 done");
    assert.equal(await s.page.evaluate(() => document.querySelector(".ck-progress i").style.width), "25%");
    assert.equal(await s.page.evaluate(() => document.querySelectorAll("#art-main table, #art-main .sh-grid, #art-main iframe").length), 0, "no grid and no framed page: it is drawn as a list");
    assert.equal(await s.page.evaluate(() => document.querySelector(".ck-pin").getAttribute("aria-pressed")), "true", "pinned to its project");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("a tick is one save: the whole list from the version shown, with only that item changed", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  try {
    await s.page.getByRole("checkbox", { name: "Tick Write the README as done" }).click();
    const [save] = await saves(s);
    assert.equal(save.base_version, 4);
    assert.equal(save.content.items[3].status, "Done");
    assert.deepEqual(save.content.items.slice(0, 3), s.data.content.items.slice(0, 3), "the other items are as they were");
    assert.equal((await shown(s.page))[3].ticked, "true", "shown at once");
    assert.equal(await s.page.evaluate(() => document.querySelector(".ck-sum").textContent), "2 of 4 done");
    // The process answers with the new version: the page asks for the list as it is kept (who ticked, and when).
    await s.send({ type: "saved", artifact: { ...s.data.view, version: 5 } });
    assert.equal((await s.posted("reload")).length, 1);
    // A second tick goes from the version just made.
    await s.send({ type: "detail", artifact: { ...s.data.view, version: 5 }, content: save.content, state: s.data.state });
    await s.clearPosted();
    await s.page.getByRole("checkbox", { name: "Reopen Write the parser" }).click();
    const [reopen] = await saves(s);
    assert.equal(reopen.base_version, 5);
    assert.equal(reopen.content.items[0].status, "Not started", "a ticked item reopens to Not started");
    assert.equal(reopen.content.items[0].note, s.data.content.items[0].note, "and keeps its note and proof");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the status chip is a menu of the six statuses", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  try {
    await s.page.locator('.ck-item[data-item="c2"] .ck-chip').click();
    assert.deepEqual(await s.page.evaluate(() => [...document.querySelectorAll('.ck-item[data-item="c2"] [role="menuitem"]')].map((n) => n.textContent)),
      ["Not started", "Building (now)", "Testing", "Checked live", "Needs you", "Done"]);
    await s.page.getByRole("menuitem", { name: "Checked live" }).click();
    const [save] = await saves(s);
    assert.equal(save.content.items[1].status, "Checked live");
    assert.equal((await shown(s.page))[1].chip, "Checked live");
    await s.page.locator('.ck-item[data-item="c2"] .ck-chip').click();
    await s.page.keyboard.press("Escape");
    assert.equal(await s.page.evaluate(() => document.activeElement.classList.contains("ck-chip")), true, "Escape closes it and gives the chip back the focus");
    assert.equal((await saves(s)).length, 1, "the status it has is not a change");
  } finally { await s.page.close(); }
});

test("what done means is changed in place, and saved as that one change", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  try {
    await s.page.getByRole("button", { name: "Change done when for Add the tests" }).click();
    const box = s.page.getByRole("textbox", { name: "Done when for Add the tests" });
    assert.equal(await box.inputValue(), "pytest passes with 10 or more tests");
    await box.fill("pytest passes with 25 or more tests");
    await s.page.getByRole("button", { name: "Save", exact: true }).click();
    const [save] = await saves(s);
    assert.equal(save.content.items[1].done_when, "pytest passes with 25 or more tests");
    assert.equal(save.content.items[1].status, "Building");
    // Escape leaves it as it was.
    await s.send({ type: "saved", artifact: { ...s.data.view, version: 5 } });
    await s.send({ type: "detail", artifact: { ...s.data.view, version: 5 }, content: save.content, state: s.data.state });
    await s.clearPosted();
    await s.page.getByRole("button", { name: "Change done when for Write the README" }).click();
    await s.page.getByRole("textbox", { name: "Done when for Write the README" }).fill("anything");
    await s.page.keyboard.press("Escape");
    assert.equal((await saves(s)).length, 0);
    assert.equal((await shown(s.page))[3].doneWhen, "README says how to install it and run it, with one example");
  } finally { await s.page.close(); }
});

test("a save that finds a newer list is made again on it, with nothing asked and nothing of DGC's lost", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  try {
    await s.page.getByRole("checkbox", { name: "Tick Write the README as done" }).click();
    await s.send({ type: "rejected", what: "save", reason: "conflict", message: "“Ship the parser” changed since version 4." });
    assert.equal(await s.page.evaluate(() => document.getElementById("art-banner").hidden), true, "no question");
    assert.equal((await s.posted("reload")).length, 1, "the newer list is read");
    // Meanwhile DGC had finished the tests.
    const newer = JSON.parse(JSON.stringify(s.data.content));
    Object.assign(newer.items[1], { status: "Done", note: "12 tests", proof: [{ kind: "text", text: "12 passed" }], by: "DGC" });
    await s.send({ type: "detail", artifact: { ...s.data.view, version: 5 }, content: newer, state: s.data.state });
    const again = (await saves(s)).at(-1);
    assert.equal(again.base_version, 5);
    assert.equal(again.content.items[1].status, "Done", "DGC's change is kept");
    assert.equal(again.content.items[1].note, "12 tests");
    assert.equal(again.content.items[3].status, "Done", "and yours is made on it");
    // A second refusal is said, and the page goes back to what is kept.
    await s.send({ type: "rejected", what: "save", reason: "conflict", message: "It changed since version 5." });
    assert.equal(await s.page.evaluate(() => document.getElementById("art-banner").hidden), false);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("DGC's change while it is open is shown at once; a box you are typing in stays", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  try {
    await s.send({ type: "changed", artifact: { ...s.data.view, version: 5 }, op: "changed" });
    assert.equal((await s.posted("reload")).length, 1, "nothing unsaved here: it reloads by itself");
    const newer = JSON.parse(JSON.stringify(s.data.content));
    newer.items[1].status = "Testing";
    await s.send({ type: "detail", artifact: { ...s.data.view, version: 5 }, content: newer, state: s.data.state });
    assert.equal((await shown(s.page))[1].chip, "Testing");
    await s.page.getByRole("button", { name: "Change done when for Write the README" }).click();
    await s.page.getByRole("textbox", { name: "Done when for Write the README" }).fill("README has an example");
    newer.items[1].status = "Done";
    await s.send({ type: "detail", artifact: { ...s.data.view, version: 6 }, content: newer, state: s.data.state });
    assert.equal(await s.page.getByRole("textbox", { name: "Done when for Write the README" }).inputValue(), "README has an example");
    await s.clearPosted();
    await s.page.getByRole("button", { name: "Save", exact: true }).click();
    const [save] = await saves(s);
    assert.equal(save.base_version, 6);
    assert.equal(save.content.items[1].status, "Done", "saved on the list as it is now");
    assert.equal(save.content.items[3].done_when, "README has an example");
  } finally { await s.page.close(); }
});

test("Pin, Add and Remove are each one save; the picture opens larger", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  const answer = async (save, version) => { await s.send({ type: "saved", artifact: { ...s.data.view, version } });
    await s.send({ type: "detail", artifact: { ...s.data.view, version }, content: save.content, state: s.data.state }); await s.clearPosted(); };
  try {
    await s.page.getByRole("button", { name: "Pinned" }).click();
    let [save] = await saves(s);
    assert.equal(save.content.pinned, false);
    assert.equal(await s.page.evaluate(() => document.querySelector(".ck-pin").textContent), "Pin");
    await answer(save, 5);
    await s.page.getByRole("textbox", { name: "A new item's title" }).fill("Tag the release");
    await s.page.getByRole("textbox", { name: "What done means for the new item" }).fill("v1.0 is tagged");
    await s.page.getByRole("button", { name: "Add", exact: true }).click();
    [save] = await saves(s);
    assert.deepEqual(save.content.items.at(-1), { id: "c5", title: "Tag the release", done_when: "v1.0 is tagged", status: "Not started", note: "", proof: [] });
    await answer(save, 6);
    await s.page.getByRole("button", { name: "Remove Tag the release" }).click();
    assert.match(await s.page.evaluate(() => document.getElementById("art-banner").textContent), /Remove “Tag the release” from the checklist\?/);
    assert.equal((await saves(s)).length, 0, "it asks first");
    await s.page.locator("#art-banner").getByRole("button", { name: "Remove" }).click();
    [save] = await saves(s);
    assert.deepEqual(save.content.items.map((i) => i.id), ["c1", "c2", "c3", "c4"]);
    assert.equal(save.content.last, 5, "its number is not given again");
    await s.page.getByRole("button", { name: "Open the picture: The run, all three read" }).click();
    assert.equal(await s.page.evaluate(() => document.querySelector("dialog.ck-picture")?.open), true);
    await s.page.getByRole("button", { name: "Close" }).click();
    await s.page.waitForFunction(() => !document.querySelector("dialog.ck-picture"), null, { timeout: 5000 });
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("removed: it locks, as every artifact does", async (t) => {
  if (skipOrFail(t)) return;
  const s = await open();
  try {
    await s.send({ type: "changed", artifact: s.data.view, op: "removed" });
    assert.equal(await s.page.evaluate(() => [...document.querySelectorAll(".ck-tick, .ck-chip, .ck-pin, .ck-add input, .ck-add button")].every((n) => n.disabled)), true);
  } finally { await s.page.close(); }
});

for (const theme of ["dark-modern", "light-modern"]) {
  for (const width of [300, 440, 700]) {
    test(`${theme} at ${width}px: nothing runs off the side, the chips read (4.5:1), one corner and one height`, async (t) => {
      if (skipOrFail(t)) return;
      const s = await open({ width, height: 900, theme });
      try {
        const fit = await s.page.evaluate(() => ({ page: document.documentElement.scrollWidth <= window.innerWidth,
          main: document.getElementById("art-main").scrollWidth <= document.getElementById("art-main").clientWidth + 1,
          out: [...document.querySelectorAll(".ck *")].filter((n) => { const r = n.getBoundingClientRect(); return r.width > 0 && (r.right > window.innerWidth + 0.5 || r.left < -0.5); }).map((n) => n.className).slice(0, 5) }));
        assert.deepEqual(fit, { page: true, main: true, out: [] });
        for (const mark of [...await contrastOf(s.page, ".ck-chip > span:first-child"), ...await contrastOf(s.page, ".ck-title"), ...await contrastOf(s.page, ".ck-words"),
          ...await contrastOf(s.page, ".ck-label"), ...await contrastOf(s.page, ".ck-who"), ...await contrastOf(s.page, ".ck-sum"), ...await contrastOf(s.page, ".ck-proof-text")]) {
          assert.ok(mark.ratio >= 4.5, `${mark.words}: ${mark.ratio}:1`);
        }
        const look = await s.page.evaluate(() => { const css = (sel) => getComputedStyle(document.querySelector(sel));
          return { chip: [css(".ck-chip").height, css(".ck-chip").borderRadius], pin: [css(".ck-pin").height], item: css(".ck-item").borderRadius, add: [css(".ck-add input").height, css(".ck-add input").borderRadius],
                   picture: css(".ck-pic").borderRadius }; });
        assert.deepEqual(look, { chip: ["28px", "6px"], pin: ["28px"], item: "6px", add: ["28px", "6px"], picture: "6px" });
        await shot(s.page, `panel-${theme.startsWith("light") ? "light" : "dark"}-${width}`);
        assert.deepEqual(s.errors, []);
      } finally { await s.page.close(); }
    });
  }
}

// ---- its card in a Work chat ------------------------------------------------------------------------------------------------
test("in a Work chat its card says how far along it is, and keeps saying it as DGC works; a reloaded chat has it back", async (t) => {
  if (skipOrFail(t)) return;
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 440, height: 760 }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES["dark-modern"]} }` });
    await page.evaluate(() => document.body.classList.add("vscode-dark"));
    await page.evaluate(([mjs, mdjs]) => {
      window.__posted = [];
      window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
      eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
      eval(mjs);
    }, [mainJs, markdownJs]);
    const send = (event) => page.evaluate((e) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: e } })), event);
    await send({ type: "ready", version: "0.52.0", protocol_version: 14, capabilities: { artifacts: { version: 1, types: ["checklist"], outputs: ["auto"], exports: { checklist: ["md", "html", "pdf"] } } },
                 model: "m", mode: "default", think: "off", base_url: "http://localhost:11434/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
                 context_size: 65536, session_id: "s1" });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
    const made = { ...data.checklist.view, version: 1, progress: { done: 0, total: 4, needs: [], next: { id: "c1", title: "Write the parser", status: "Not started" }, pinned: true } };
    await send({ type: "turn_start", turn_id: "t1", prompt: "Make a checklist for the parser and work through it", kind: "prompt" });
    await send({ type: "artifact_changed", artifact: made, op: "made", surface: "work" });
    const card = page.locator(".artifact-card");
    assert.equal(await card.count(), 1);
    assert.equal(await card.locator(".anm").textContent(), "Ship the parser");
    assert.equal(await card.locator(".ameta").textContent(), "Checklist · 0 of 4 done · version 1 · made");
    assert.equal(await card.locator(".aico .dgc-sheet").getAttribute("data-kind"), "checklist");
    await send({ type: "artifact_changed", artifact: { ...made, version: 3, progress: { ...made.progress, done: 1 } }, op: "changed", surface: "work" });
    assert.equal(await card.count(), 1, "the same card, as it is now");
    assert.equal(await card.locator(".ameta").textContent(), "Checklist · 1 of 4 done · version 3 · changed");
    await card.getByRole("button", { name: "Open Ship the parser" }).click({ force: true });
    assert.deepEqual(await page.evaluate(() => window.__posted.filter((m) => m.type === "artifactOpen")), [{ type: "artifactOpen", id: made.id, artifactType: "checklist", title: "Ship the parser" }]);
    // A reloaded chat: the card comes back from what the tool told the model.
    await send({ type: "history", items: [
      { type: "turn_start", turn_id: "t9", prompt: "Carry on", kind: "prompt" },
      { type: "tool_call", call_id: "c1", name: "edit_artifact", args: { id: made.id } },
      { type: "tool_result", call_id: "c1", name: "edit_artifact", is_error: false,
        output: `Changed Checklist \u201cShip the parser\u201d (${made.id}, version 5): c2 \u201cAdd the tests\u201d: Building \u2192 Done. 2 of 4 done. Next: c3 \u201cPublish the package\u201d.` }] });
    assert.equal(await page.locator(".artifact-card .ameta").last().textContent(), "Checklist · version 5 · changed");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});

// ---- the Library ----------------------------------------------------------------------------------------------------------
test("the Library lists it among the artifacts, with its own small sheet and a Checklists kind", async (t) => {
  if (skipOrFail(t)) return;
  const made = { ...LIB_ARTIFACTS[1], id: ar(41), type: "checklist", label: "Checklist", title: "Ship the parser", exports: ["md", "html", "pdf"], updated: "ago:5", created: "ago:90",
                 origin: { surface: "work", session: SESSION, project: "/home/me/code/shop" }, progress: data.checklist.view.progress };
  const x = await openLibraryTab(browser, { artifacts: [...LIB_ARTIFACTS, made], width: 300 });
  try {
    let l = await x.lib();
    assert.equal(l.rows[0].title, "Ship the parser", "newest first");
    assert.equal(await x.page.evaluate(() => document.querySelector(".lib-row .lib-row-thumb .dgc-sheet")?.dataset.kind), "checklist", "its own small sheet");
    assert.equal(await x.page.evaluate(() => document.querySelector(".lib-row .lib-row-thumb .dgc-sheet-tag")?.textContent), "List");
    assert.equal(await x.page.evaluate(() => document.querySelectorAll(".lib-row .lib-row-thumb .dgc-sheet .tick").length), 4, "four lines, each with its box");
    assert.deepEqual((await x.menu("kind")).map((r) => r.label), ["All", "Pages", "Sheets", "Docs", "Decks", "Dashboards", "Checklists"]);
    await x.pick("kind", "Checklists"); l = await x.lib();
    assert.deepEqual(l.rows.map((r) => r.title), ["Ship the parser"]);
    assert.equal(l.filters[0].value, "Checklists");
    if (SHOTS) await shot(x.page, "library-dark-300");
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

// ---- Work's list ----------------------------------------------------------------------------------------------------------
const WORK = [{ id: "ar_" + "6".repeat(16), title: "Ship the parser", done: 1, total: 4, next: "Add the tests", needs: "Publish the package" },
              { id: "ar_" + "7".repeat(16), title: "Tidy the docs", done: 2, total: 5, next: "Fix the broken links", needs: "" }];
for (const theme of ["dark-modern", "light-modern"]) {
  test(`Work's list shows the project's checklists and how far along each is (${theme}, 300px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openHome(browser, { tab: "work", width: 300, theme });
    try {
      assert.equal(await x.page.evaluate(() => !!document.getElementById("work-checklists")), false, "none: no empty box");
      await x.send({ type: "workChecklists", items: WORK });
      const rows = await x.page.evaluate(() => [...document.querySelectorAll("#work-checklists .work-checklist")].map((row) => ({
        name: row.querySelector(".session-name").textContent, sub: row.querySelector(".session-sub").textContent, needs: row.querySelector(".session-sub").classList.contains("session-waiting"),
        bar: row.querySelector(".work-checklist-bar i").style.width, sheet: row.querySelector(".dgc-sheet")?.dataset.kind || "", label: row.getAttribute("aria-label"),
        above: row.getBoundingClientRect().bottom <= document.getElementById("sessions-list").getBoundingClientRect().top + 1 })));
      assert.deepEqual(rows, [
        { name: "Ship the parser", sub: "1 of 4 done · Needs you: Publish the package", needs: true, bar: "25%", sheet: "checklist", label: "Checklist: Ship the parser. 1 of 4 done. Needs you: Publish the package. Open it", above: true },
        { name: "Tidy the docs", sub: "2 of 5 done · Next: Fix the broken links", needs: false, bar: "40%", sheet: "checklist", label: "Checklist: Tidy the docs. 2 of 5 done. Next: Fix the broken links. Open it", above: true }]);
      assert.equal(await x.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "nothing runs off the side at 300px");
      assert.equal(await x.page.evaluate(() => [...document.querySelectorAll("#work-checklists .work-checklist")].every((row) => {
        const sheet = row.querySelector(".dgc-sheet").getBoundingClientRect(), words = row.querySelector(".session-main").getBoundingClientRect(), box = row.getBoundingClientRect();
        return sheet.right <= words.left && sheet.top >= box.top && sheet.bottom <= box.bottom && sheet.width <= 24; })), true, "its small sheet stands beside the words, inside its row");
      for (const mark of [...await contrastOf(x.page, "#work-checklists .session-name"), ...await contrastOf(x.page, "#work-checklists .session-sub")]) assert.ok(mark.ratio >= 4.5, `${mark.words}: ${mark.ratio}:1`);
      await shot(x.page, `work-list-${theme.startsWith("light") ? "light" : "dark"}-300`);
      // A click (or Enter) opens it in its panel.
      await x.page.locator("#work-checklists .work-checklist").first().click();
      await x.page.locator("#work-checklists .work-checklist").nth(1).focus();
      await x.page.keyboard.press("Enter");
      assert.deepEqual(await x.posted("artifactOpen"), [{ type: "artifactOpen", id: WORK[0].id, artifactType: "checklist", title: "Ship the parser" },
        { type: "artifactOpen", id: WORK[1].id, artifactType: "checklist", title: "Tidy the docs" }]);
      // Every item done says so; a list that changed is drawn again; none hides the box.
      await x.send({ type: "workChecklists", items: [{ ...WORK[1], done: 5, next: "" }] });
      assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll("#work-checklists .session-sub")].map((n) => n.textContent)), ["5 of 5 done · Every item is done"]);
      await x.send({ type: "workChecklists", items: [] });
      assert.equal(await x.page.evaluate(() => document.getElementById("work-checklists").hidden), true);
      // What isn't a checklist's row is dropped, never drawn.
      await x.send({ type: "workChecklists", items: [{ id: "<img src=x>", title: "x" }, { ...WORK[0], title: "<b>Ship</b>" }] });
      assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll("#work-checklists .session-name")].map((n) => [n.textContent, n.children.length])), [["<b>Ship</b>", 0]]);
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("Work's list on All projects names each checklist's folder; a search's finds stand alone", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openHome(browser, { tab: "work", width: 440 });
  try {
    await x.send({ type: "workChecklists", items: [{ ...WORK[0], folder: "shop" }] });
    assert.equal(await x.page.evaluate(() => document.querySelector("#work-checklists .session-sub").textContent), "1 of 4 done · Needs you: Publish the package · shop");
    await shot(x.page, "work-list-dark-440");
    await x.send({ type: "sessions_list", items: [], error: "", searchable: true, query: "totals" });
    assert.equal(await x.page.evaluate(() => document.getElementById("work-checklists").hidden), true, "hidden while a search shows its finds");
    await x.send({ type: "sessions_list", items: [], error: "", searchable: true, query: "" });
    assert.equal(await x.page.evaluate(() => document.getElementById("work-checklists").hidden), false);
  } finally { await x.close(); }
});

// ---- the extension's side (src/artifacts.ts, bundled against a stub `vscode`) ------------------------------------------------
test("the extension's side: its progress is carried, its panel loads its editor, a tick is one artifact_update, and Work's rows", async () => {
  world.panels.length = 0;
  {
    const art = artifactsModule();
    assert.ok(art.ARTIFACT_TYPES.includes("checklist"));
    const raw = { id: "ar_" + "6".repeat(16), type: "checklist", title: "Ship the parser", version: 4, exports: ["md", "html", "pdf"], updated: "2026-10-28T08:30:00Z",
                  origin: { surface: "work", project: "/home/me/code/shop" },
                  progress: { done: 1, total: 4, needs: ["c3", "<x>"], next: { id: "c2", title: "Add the tests", status: "Building" }, waiting: { id: "c3", title: "Publish the package" }, pinned: true, more: "dropped" } };
    const view = art.artifactView(raw);
    assert.equal(view.label, "Checklist");
    assert.deepEqual(view.progress, { done: 1, total: 4, needs: ["c3"], next: { id: "c2", title: "Add the tests", status: "Building" }, waiting: { id: "c3", title: "Publish the package" }, pinned: true });
    assert.equal(art.artifactView({ ...raw, type: "sheet" }).progress, undefined, "only a checklist has it");
    // Work's rows: the folder's pinned ones, the latest change first; every folder's on All projects, each named.
    const other = art.artifactView({ ...raw, id: "ar_" + "7".repeat(16), title: "Garden", updated: "2026-10-29T08:30:00Z", origin: { surface: "work", project: "/home/me/code/garden" } });
    const unpinned = art.artifactView({ ...raw, id: "ar_" + "8".repeat(16), title: "Old", progress: { ...raw.progress, pinned: false } });
    const chat = art.artifactView({ ...raw, id: "ar_" + "9".repeat(16), title: "A chat's", origin: { surface: "chat", chat: "chat_1" } });
    assert.deepEqual(art.workChecklistRows([view, other, unpinned, chat], "/home/me/code/shop/"),
      [{ id: raw.id, title: "Ship the parser", done: 1, total: 4, next: "Add the tests", needs: "Publish the package" }]);
    assert.deepEqual(art.workChecklistRows([view, other, unpinned, chat], "", true).map((r) => [r.title, r.folder]), [["Garden", "garden"], ["Ship the parser", "shop"]]);
    assert.deepEqual(art.workChecklistRows([view], ""), [], "no folder: none");
    // Its panel: the checklist's editor is loaded before the panel's own script; a tick goes out as one artifact_update.
    const sent = [];
    const hub = new art.Artifacts({ extensionUri: uri("/ext"), subscriptions: [] });
    hub.attach({ send(cmd) { sent.push(cmd); return "sent"; }, offers: () => ({ version: 1, types: art.ARTIFACT_TYPES, outputs: [], exports: { checklist: ["md", "html", "pdf"] }, present: false }) });
    hub.open(raw.id, { type: "checklist", title: "Ship the parser" });
    const [panel] = world.panels;
    const order = [...panel.webview.html.matchAll(/media\/(artifact\w*)\.js/g)].map((m) => m[1]);
    assert.ok(order.indexOf("artifactChecklist") >= 0 && order.indexOf("artifactChecklist") < order.indexOf("artifact"), `its editor loads first: ${order}`);
    panel.say({ type: "ready" });
    const get = sent.find((c) => c.type === "artifact_get");
    assert.equal(get.content, true);
    const content = { pinned: true, items: [{ id: "c1", title: "One", done_when: "", status: "Not started", note: "", proof: [] }] };
    hub.onEvent({ type: "artifact_detail", artifact: raw, content, state: { pictures: { "proof/abc.png": "data:image/png;base64,AAAA" } }, request_id: get.request_id });
    const detail = panel.last("detail");
    assert.deepEqual(detail.artifact.progress.next, { id: "c2", title: "Add the tests", status: "Building" });
    assert.deepEqual(detail.state, { pictures: { "proof/abc.png": "data:image/png;base64,AAAA" } }, "its pictures reach the page");
    const ticked = { ...content, items: [{ ...content.items[0], status: "Done" }] };
    panel.say({ type: "save", content: ticked, base_version: 4 });
    const update = sent.find((c) => c.type === "artifact_update");
    assert.deepEqual({ ...update, request_id: "" }, { type: "artifact_update", id: raw.id, content: ticked, base_version: 4, request_id: "" });
    hub.onEvent({ type: "artifact_changed", artifact: { ...raw, version: 5, progress: { ...raw.progress, done: 2 } }, op: "changed", surface: "editor", request_id: update.request_id });
    assert.equal(panel.last("saved").artifact.version, 5);
    assert.equal(panel.last("saved").artifact.progress.done, 2);
    // Every screen hears a checklist changed (Work's list asks for its rows again on this).
    const heard = [];
    hub.listen((m) => heard.push(m));
    hub.onEvent({ type: "artifact_changed", artifact: { ...raw, version: 6 }, op: "changed", surface: "work" });
    assert.equal(heard.find((m) => m.type === "artifactChanged")?.artifact.type, "checklist");
  }
});

test("the side bar asks for the project's checklists with the list, and again when one changes", async () => {
  const { readFileSync } = await import("node:fs");
  const panel = readFileSync(new URL("../src/panel.ts", import.meta.url), "utf8");
  assert.match(panel, /this\.postSessionItems\(items, error\);\s*void this\.postWorkChecklists\(\);/);
  assert.match(panel, /message\.type === "artifactChanged" && home && \(message\.artifact as any\)\?\.type === "checklist"\) \{ void this\.postWorkChecklists\(\); \}/);
  assert.match(panel, /this\.post\(\{ type: "workChecklists", items: workChecklistRows\(views, wanted, !!folders && !choice\) \}\)/);
  assert.ok(panelPage().scripts.includes("media/artifactChecklist.js"));
});
