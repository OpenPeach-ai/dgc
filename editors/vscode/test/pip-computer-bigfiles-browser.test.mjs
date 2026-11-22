// Big files in a Pip computer's Files (pc-background-commands, Pips API 87), laid out in real Chromium with the real client
// and its CSS (test/support/pip-computer-files-scene.mjs), dark and light, at a 700 px tab and a 300 px one:
// Add file…, a copy running (the names with "copying"), a file's Download, and DGC's over-the-limit words.
// Nothing is clipped, nothing overlaps, nothing leaves the window, and the buttons are the shared quiet ones (no purple).
// What the page and the host say to each other is in pip-computer-bigfiles.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openFiles, FILES } from "./support/pip-computer-files-scene.mjs";

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
const PURPLE = /rgba?\((124, 92, 255|118, 84, 246|106, 75, 240|167, 139, 250)/;
const measure = (p) => p.evaluate(() => {
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const one = (s) => { const e = document.querySelector(s); return e ? { id: s, ...box(e), text: e.textContent, clipped: e.scrollWidth > e.clientWidth + 1, disabled: e.disabled === true,
    ground: getComputedStyle(e).backgroundColor, ink: getComputedStyle(e).color, shared: e.classList.contains("dgc-btn") } : null; };
  return { view: [innerWidth, innerHeight], window: box(document.querySelector(".pc-window")), pane: box(document.querySelector(".pc-files")), list: box(document.querySelector(".pc-list")),
    add: one("#pc-add"), save: one("#pc-save-as"), remove: one("#pc-remove"), crumbs: one(".pc-crumbs"), error: one(".pc-files .pc-error"), title: one(".pc-preview .pc-bar strong"),
    bytes: one(".pc-preview .pc-bar .pc-muted"),
    copying: [...document.querySelectorAll(".pc-copying")].map((li) => ({ ...box(li), name: box(li.querySelector(".pc-name")), word: box(li.querySelector(".pc-size")), text: li.querySelector(".pc-size").textContent })),
    paneScrollsSideways: document.querySelector(".pc-files").scrollWidth > document.querySelector(".pc-files").clientWidth + 1,
    pageScrollsSideways: document.documentElement.scrollWidth > innerWidth + 1 };
});
const within = (a, b, name) => assert.ok(a && b && a.left >= b.left - 0.5 && a.right <= b.right + 0.5 && a.top >= b.top - 0.5 && a.bottom <= b.bottom + 0.5, `${name}: ${JSON.stringify(a)} in ${JSON.stringify(b)}`);
const apart = (a, b, name) => assert.ok(!(a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5), `${name} overlap: ${JSON.stringify(a)} ${JSON.stringify(b)}`);
const quiet = (b, name) => { assert.ok(b.shared, `${name} is the shared button`); assert.ok(!PURPLE.test(b.ground) && !PURPLE.test(b.ink), `${name} is not purple: ${b.ground} ${b.ink}`); };

for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  test(`Files at ${width}px, ${theme}: Add file…, a copy running, Download and the over-the-limit words all fit`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openFiles(browser, { theme, width });
    try {
      // Add file…
      let m = await measure(x.p);
      assert.equal(m.add.text, "Add file…"); quiet(m.add, "Add file…");
      assert.ok(!m.add.clipped, "Add file… shows all its words");
      within(m.add, m.pane, "Add file… is inside Files"); apart(m.add, m.crumbs, "Add file… and the folder");
      within(m.window, { left: 0, top: 0, right: m.view[0], bottom: m.view[1] }, "the window is inside the tab");
      // A copy running: the picked names, each "copying", in the list.
      await x.p.click("#pc-add");
      assert.deepEqual(await x.posted("pipComputerAddFiles"), [{ type: "pipComputerAddFiles", folder: "" }]);
      await x.say({ type: "pipComputerAdding", names: ["holiday-video-2026-final-cut-for-the-family.mp4", "dataset.bin"] });
      await x.p.waitForSelector(".pc-copying");
      m = await measure(x.p);
      assert.equal(m.add.text, "Adding…"); assert.ok(m.add.disabled && !m.add.clipped);
      assert.equal(m.copying.length, 2);
      for (const row of m.copying) {
        assert.equal(row.text, "copying");
        within(row, m.list, "a copying row is inside the list"); within(row.name, row, "its name stays in the row"); within(row.word, row, "\"copying\" stays in the row");
        apart(row.name, row.word, "the name and \"copying\"");
        assert.ok(row.word.width > 30, "\"copying\" is not squeezed out by a long name");
      }
      assert.ok(!m.paneScrollsSideways && !m.pageScrollsSideways, "nothing scrolls sideways");
      // Over the limit: DGC's words, wrapped inside the panel.
      await x.scene({ files: [...FILES, { name: "dataset.bin", kind: "file", bytes: 734_003_200, modified: 9 }] });
      await x.say({ type: "pipComputerAdded", added: ["dataset.bin"], errors: [LIMIT] });
      await x.p.waitForSelector(".pc-files .pc-error");
      await x.p.waitForSelector('[data-file="dataset.bin"]');
      m = await measure(x.p);
      assert.equal(m.error.text, LIMIT); within(m.error, m.pane, "the words are inside Files"); assert.ok(!m.error.clipped, "all of them");
      apart(m.error, m.add, "the words and Add file…"); apart(m.error, m.list, "the words and the list");
      assert.equal(m.add.text, "Add file…"); assert.equal(m.copying.length, 0);
      assert.ok(!m.paneScrollsSideways && !m.pageScrollsSideways, "nothing scrolls sideways");
      // The words stay until something else happens: their × (media/shared/dismiss.js) puts them away.
      const cross = await x.p.evaluate(() => { const b = document.querySelector(".pc-files .pc-error > .dgc-dismiss"), r = b?.getBoundingClientRect(), l = b?.parentElement.getBoundingClientRect();
        return b && { title: b.title, name: b.getAttribute("aria-label"), w: r.width, h: r.height, inside: r.right <= l.right + 1 && r.left >= l.left - 1 }; });
      assert.deepEqual(cross, { title: "Dismiss", name: "Dismiss this message", w: 26, h: 26, inside: true });
      await x.p.click(".pc-files .pc-error > .dgc-dismiss");
      assert.equal(await x.p.evaluate(() => document.querySelector(".pc-files .pc-error").checkVisibility()), false, "closed");
      assert.notEqual(await x.p.evaluate(() => document.activeElement?.tagName), "BODY", "the focus is on something");
      // A big file's Download
      await x.p.click('[data-file="dataset.bin"]');
      await x.p.waitForSelector("#pc-save-as");
      m = await measure(x.p);
      assert.equal(m.save.text, "Download"); quiet(m.save, "Download"); quiet(m.remove, "Remove");
      assert.ok(!m.save.clipped && !m.remove.clipped && !m.save.disabled, "both show all their words, and a 700 MB file can be saved");
      assert.equal(m.bytes.text, "700.0 MB");
      for (const [name, b] of [["Download", m.save], ["Remove", m.remove], ["the file's name", m.title], ["its size", m.bytes]]) within(b, m.pane, `${name} is inside Files`);
      apart(m.save, m.remove, "Save and Remove"); apart(m.save, m.title, "Save and the name"); apart(m.remove, m.title, "Remove and the name");
      apart(m.save, m.bytes, "Save and the size"); apart(m.title, m.bytes, "the name and the size");
      assert.ok(Math.abs(m.save.height - m.remove.height) < 0.5, "Save and Remove are the same height");
      assert.ok(!m.paneScrollsSideways && !m.pageScrollsSideways, "nothing scrolls sideways");
      await x.p.click("#pc-save-as");
      assert.deepEqual(await x.posted("pipComputerSaveAs"), [{ type: "pipComputerSaveAs", path: "dataset.bin" }]);
      m = await measure(x.p);
      assert.equal(m.save.text, "Downloading…"); assert.ok(m.save.disabled && !m.save.clipped);
      await x.say({ type: "pipComputerSavedAs", ok: true, name: "dataset.bin" });
      await x.p.waitForFunction(() => document.querySelector(".pc-notice")?.textContent === "Saved to dataset.bin.");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("before API 87 the Files panel is as it was: Add files… and Download", async (t) => {
  if (skipOrFail(t)) return;
  const x = await openFiles(browser, { api: 86 });
  try {
    assert.equal(await x.p.textContent("label.pc-add"), "Add files…");
    assert.equal(await x.p.$("#pc-add"), null);
    await x.p.click('[data-file="notes.txt"]');
    await x.p.waitForSelector("#pc-save");
    assert.equal(await x.p.textContent("#pc-save"), "Download");
    assert.equal(await x.p.$("#pc-save-as"), null);
    assert.deepEqual(x.errors, []);
  } finally { await x.close(); }
});
