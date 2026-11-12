// Files under a Pip computer's live screen (pc-background-commands, 0.52). With a live desktop the tab is the screen and
// its bar, and there was no Files at all there: no way to add or save a big file. Now the bar has a Files button beside
// Keyboard and Clipboard, opening a panel with the same list, folder, sizes and "x used" as the Files window,
// Add file…, and for a chosen file Save to this computer… and Remove, through the same host messages.
// From 12 Nov the panel floats over the screen and never pushes it, and the bar is one row: at 700 px the tools are their
// marks, and at 300 px Fit and 100% are in "…" (pip-computer-room-browser.test.mjs).
// Real Chromium, the real client and CSS, the real noVNC viewer on a fake RFB server (support/pip-computer-scene.mjs),
// dark and light, at a 700 px tab and a 300 px one.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openComputer } from "./support/pip-computer-scene.mjs";
import { FILES } from "./support/pip-computer-files-scene.mjs";

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

const LIMIT = "That file is 1.4 GB. A Pip's computer takes files up to 1 GB.";
const BIG = { name: "dataset.bin", kind: "file", bytes: 734_003_200, modified: 9 };
const PURPLE = /rgba?\((124, 92, 255|118, 84, 246|106, 75, 240|167, 139, 250)/;
const say = (p, message) => p.evaluate((m) => window.postMessage(m, "*"), message);
const posted = (p, type) => p.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
const sent = (p, type) => p.evaluate((t) => window.__sent.filter((r) => r.type === t), type);
const measure = (p) => p.evaluate(() => {
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const one = (s) => { const e = document.querySelector(s); return e ? { id: s, ...box(e), text: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1, disabled: e.disabled === true, title: e.title,
    expanded: e.getAttribute("aria-expanded"), ground: getComputedStyle(e).backgroundColor, ink: getComputedStyle(e).color, shared: e.classList.contains("dgc-btn") } : null; };
  const label = document.querySelector("#pc-files .pc-tool-label")?.getBoundingClientRect();
  const panel = document.getElementById("pc-files-panel"), holder = document.getElementById("pc-panel");
  return { view: [innerWidth, innerHeight], tools: box(document.getElementById("pc-tools")), holder: box(holder), panel: box(panel), list: box(document.querySelector("#pc-files-panel .pc-list")),
    canvas: box(document.querySelector("#pc-vnc canvas")), live: box(document.getElementById("pc-live")),
    button: one("#pc-files"), icon: !!document.querySelector("#pc-files svg"), label: label ? [label.width, label.height] : null,
    bar: [...document.querySelectorAll("#pc-tools button")].map((b) => ({ id: b.id, ...box(b) })),
    add: one("#pc-add"), save: one("#pc-save-as"), remove: one("#pc-remove"), crumbs: one("#pc-files-panel .pc-crumbs"), error: one("#pc-files-panel .pc-error"),
    title: one("#pc-files-panel .pc-preview .pc-bar strong"), bytes: one("#pc-files-panel .pc-preview .pc-bar .pc-muted"), used: one("#pc-files-panel>.pc-muted"),
    names: [...document.querySelectorAll("#pc-files-panel .pc-list .pc-name")].map((e) => e.textContent),
    copying: [...document.querySelectorAll("#pc-files-panel .pc-copying")].map((li) => ({ ...box(li), name: box(li.querySelector(".pc-name")), word: box(li.querySelector(".pc-size")), text: li.querySelector(".pc-size").textContent })),
    sideways: (panel && panel.scrollWidth > panel.clientWidth + 1) || holder.scrollWidth > holder.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth + 1 };
});
const within = (a, b, name) => assert.ok(a && b && a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5, `${name}: ${JSON.stringify(a)} in ${JSON.stringify(b)}`);
const across = (a, b, name) => assert.ok(a && b && a.left >= b.left - 0.5 && a.right <= b.right + 0.5, `${name}: ${JSON.stringify(a)} across ${JSON.stringify(b)}`);
const apart = (a, b, name) => assert.ok(!(a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5), `${name} overlap: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
const quiet = (b, name) => { assert.ok(b.shared, `${name} is the shared button`); assert.ok(!PURPLE.test(b.ground) && !PURPLE.test(b.ink), `${name} is not purple: ${b.ground} ${b.ink}`); };

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`under the live screen at ${width}px, ${theme}: Files opens a panel with the list, Add file…, a copy running, the limit's words and Save to this computer…`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openComputer(browser, { theme, width, api: 87, files: FILES });
    try {
      // The button: in the bar after Clipboard, an icon, its word hidden in a narrow tab.
      let m = await measure(x.p);
      assert.ok(m.button, "the bar has a Files button"); quiet(m.button, "Files"); assert.ok(m.icon, "with an icon");
      const ids = m.bar.map((b) => b.id);
      assert.equal(ids[ids.indexOf("pc-clip") + 1], "pc-files", `beside Clipboard: ${ids}`);
      assert.equal(m.button.expanded, "false"); assert.equal(m.panel, null);
      // One row for the Pip and the tools: at these widths the tools are their marks, each with its name on hover.
      assert.ok(m.label[0] <= 1.5, `its word is hidden at ${width} px, as the others' are`); assert.equal(m.button.title, "Files");
      // At 300 px Fit and 100% are in "…": what is in the bar is inside it.
      const closed = m, inBar = m.bar.filter((b) => b.width > 0);
      assert.deepEqual(m.bar.filter((b) => !b.width).map((b) => b.id), width === 300 ? ["pc-fit", "pc-actual"] : []);
      for (const b of inBar) within(b, m.tools, `${b.id} is inside the bar`);
      for (let i = 0; i < inBar.length; i++) for (let j = i + 1; j < inBar.length; j++) if (!(inBar[i].id === "pc-fit" && inBar[j].id === "pc-actual")) apart(inBar[i], inBar[j], `${inBar[i].id} and ${inBar[j].id}`);
      assert.equal((await sent(x.p, "list_pip_computer_files")).length, 0, "nothing is read until it opens");
      // Open: the folder, as the Files window shows it.
      await x.p.click("#pc-files"); await x.p.waitForSelector("#pc-files-panel .pc-name");
      m = await measure(x.p);
      assert.equal(m.button.expanded, "true");
      assert.deepEqual(m.names, ["Downloads", "notes.txt", "quarterly-figures-2026.xlsx"]);
      assert.equal(m.crumbs.text, "Files"); assert.match(m.used.text, /^47\.1 KB used\./);
      assert.equal(m.add.text, "Add file…"); quiet(m.add, "Add file…"); assert.ok(!m.add.clipped && !m.add.disabled);
      across(m.panel, { left: 0, right: m.view[0] }, "the panel is inside the tab"); within(m.add, m.panel, "Add file… is inside the panel"); apart(m.add, m.crumbs, "Add file… and the folder");
      // Over the screen, from the bar down: the screen keeps its place and size under it.
      assert.ok(m.panel.top >= m.tools.bottom - 0.5, "the panel starts under the bar"); within(m.holder, m.live, "the panel is over the screen, inside its room");
      assert.deepEqual([m.live.top, m.live.height, m.canvas.top, m.canvas.height], [closed.live.top, closed.live.height, closed.canvas.top, closed.canvas.height], "the screen does not move or shrink");
      assert.ok(m.canvas.height > 60 && m.canvas.bottom <= m.view[1] + 0.5, `the screen keeps its room below: ${JSON.stringify(m.canvas)}`);
      assert.ok(!m.sideways, "nothing scrolls sideways");
      // Add file…: the host is asked with the folder; the picked names show as "copying".
      await x.p.click("#pc-add");
      assert.deepEqual(await posted(x.p, "pipComputerAddFiles"), [{ type: "pipComputerAddFiles", folder: "" }]);
      await say(x.p, { type: "pipComputerAdding", names: ["holiday-video-2026-final-cut-for-the-family.mp4", "dataset.bin"] });
      await x.p.waitForSelector("#pc-files-panel .pc-copying");
      m = await measure(x.p);
      assert.equal(m.add.text, "Adding…"); assert.ok(m.add.disabled && !m.add.clipped);
      assert.equal(m.copying.length, 2);
      for (const row of m.copying) { assert.equal(row.text, "copying"); across(row, m.list, "a copying row is in the list"); within(row.name, row, "its name stays in the row"); within(row.word, row, "\"copying\" stays in the row");
        apart(row.name, row.word, "the name and \"copying\""); assert.ok(row.word.width > 30, "\"copying\" is not squeezed out"); }
      assert.ok(!m.sideways, "nothing scrolls sideways");
      // Over the limit: DGC's words, wrapped inside the panel.
      await x.scene({ files: [...FILES, BIG] });
      await say(x.p, { type: "pipComputerAdded", added: ["dataset.bin"], errors: [LIMIT] });
      await x.p.waitForSelector("#pc-files-panel .pc-error"); await x.p.waitForSelector('#pc-files-panel [data-file="dataset.bin"]');
      m = await measure(x.p);
      assert.equal(m.error.text, LIMIT); within(m.error, m.panel, "the words are inside the panel"); assert.ok(!m.error.clipped);
      apart(m.error, m.add, "the words and Add file…"); apart(m.error, m.list, "the words and the list");
      assert.ok(!m.sideways, "nothing scrolls sideways");
      // A big file: Save to this computer… and Remove.
      await x.p.click('#pc-files-panel [data-file="dataset.bin"]'); await x.p.waitForSelector("#pc-save-as");
      m = await measure(x.p);
      assert.equal(m.save.text, "Save to this computer…"); quiet(m.save, "Save to this computer…"); quiet(m.remove, "Remove");
      assert.ok(!m.save.clipped && !m.remove.clipped && !m.save.disabled && !m.remove.disabled);
      assert.equal(m.bytes.text, "700.0 MB");
      for (const [name, b] of [["Save to this computer…", m.save], ["Remove", m.remove], ["the file's name", m.title], ["its size", m.bytes]]) across(b, m.panel, `${name} is inside the panel`);
      apart(m.save, m.remove, "Save and Remove"); apart(m.save, m.title, "Save and the name"); apart(m.remove, m.title, "Remove and the name"); apart(m.save, m.bytes, "Save and the size"); apart(m.title, m.bytes, "the name and the size");
      within(m.holder, m.live, "the panel stays inside the screen's room"); assert.deepEqual([m.canvas.top, m.canvas.height], [closed.canvas.top, closed.canvas.height], "and the screen is where it was");
      assert.ok(!m.sideways, "nothing scrolls sideways");
      await x.p.click("#pc-save-as");
      assert.deepEqual(await posted(x.p, "pipComputerSaveAs"), [{ type: "pipComputerSaveAs", path: "dataset.bin" }]);
      await say(x.p, { type: "pipComputerSavedAs", ok: true, name: "dataset.bin" });
      await x.p.waitForFunction(() => document.querySelector(".pc-notice")?.textContent === "Saved to dataset.bin.");
      // Remove, through the command the Files window uses.
      await x.p.click("#pc-remove");
      await x.p.waitForFunction(() => !document.querySelector('#pc-files-panel [data-file="dataset.bin"]'));
      assert.deepEqual((await sent(x.p, "remove_pip_computer_file")).map((r) => r.path), ["dataset.bin"]);
      // The button closes it.
      await x.p.click("#pc-files"); await x.p.waitForFunction(() => !document.getElementById("pc-files-panel"));
      assert.equal((await measure(x.p)).button.expanded, "false");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("while a Pip run uses the computer, Files still opens and saves, and Add and Remove are off", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { api: 87, using: true, files: [...FILES, BIG] });
  try {
    let m = await measure(x.p);
    assert.ok(!m.button.disabled, "Files is open to you while it works (Keyboard and Clipboard are not)");
    await x.p.click("#pc-files"); await x.p.waitForSelector("#pc-files-panel .pc-name");
    await x.p.click('#pc-files-panel [data-file="dataset.bin"]'); await x.p.waitForSelector("#pc-save-as");
    m = await measure(x.p);
    assert.ok(m.add.disabled && m.remove.disabled, "Add and Remove are off"); assert.equal(m.add.title, "Mornings is using it"); assert.equal(m.remove.title, "Mornings is using it");
    assert.ok(!m.save.disabled, "saving a copy here changes nothing there");
    // A drop adds nothing while it is held.
    await x.p.evaluate(() => { const e = new Event("drop", { bubbles: true, cancelable: true }); e.dataTransfer = { files: [new File(["hey"], "hi.txt")], types: ["Files"] }; document.dispatchEvent(e); });
    await x.p.waitForTimeout(80);
    assert.equal((await sent(x.p, "add_pip_computer_file")).length, 0);
    assert.equal((await posted(x.p, "pipComputerAddFiles")).length, 0);
    // The run ends: they are yours again, with the panel still open.
    await x.scene({ using: false });
    await x.p.waitForSelector("#pc-add:not(:disabled)", { timeout: 15000 });
    m = await measure(x.p);
    assert.ok(!m.remove.disabled && m.panel);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});

test("before API 87 the panel has today's Add files… and Save to…, 2 MB", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openComputer(browser, { api: 86, files: FILES });
  try {
    await x.p.click("#pc-files"); await x.p.waitForSelector("#pc-files-panel .pc-name");
    assert.equal(await x.p.textContent("#pc-files-panel label.pc-add"), "Add files…");
    assert.equal(await x.p.$("#pc-add"), null);
    await x.p.click('#pc-files-panel [data-file="notes.txt"]'); await x.p.waitForSelector("#pc-save");
    assert.equal(await x.p.textContent("#pc-save"), "Save to…"); assert.equal(await x.p.$("#pc-save-as"), null);
    await x.p.click("#pc-save");
    assert.deepEqual((await posted(x.p, "pipComputerSave")).map((s) => [s.name, s.text]), [["notes.txt", "buy milk\n"]]);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
