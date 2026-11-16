// 2b: every file card in a chat has the Library's menu (media/shared/filemenu.js) on a ⋯ and on a right-click, with the
// keyboard: Open · Open in editor · Save a copy… · Copy · Copy path · Reveal in file manager. What a kind can't do is
// shown off with why, never missing. On Work, ChatDGC and a Pip's chat, for what you attached and for what DGC or a Pip
// made or sent. In real Chromium on the real pages; the host's side is in uir2c-file-menu-host.test.mjs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromiumOrNull } from "./support/look-probe.mjs";
import { launchArgs, openPipFiles } from "./support/uir2a-scene.mjs";
import { FILE_ROWS, KEPT_WHY, fileCards, openFileMenu, menuRows, pickRow, fileMoreFocused, openWorkFiles, openChatFiles, ATT } from "./support/uir2c-scene.mjs";
import { PIP } from "./support/pip-chat-scene.mjs";

const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: launchArgs }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const on = (rows) => rows.filter((r) => !r.off).map((r) => r.label), why = (rows, label) => rows.find((r) => r.label === label)?.why || "";
/** What every card must have, whatever its surface: a ⋯ that shows without a hover, is a 6px control and takes Tab. */
function checkCards(cards, names, where) {
  for (const name of names) { const c = cards.find((x) => x.name === name);
    assert.ok(c, `${where}: ${name} is a file card (${cards.map((x) => x.name).join(", ")})`);
    assert.equal(c.more, true, `${where}: ${name} has a ⋯`); assert.equal(c.label, `More for ${name}`); assert.equal(c.popup, "menu");
    assert.equal(c.shown, true, `${where}: ${name}'s ⋯ shows without a hover`); assert.equal(c.tab, 0, `${where}: ${name}'s ⋯ takes Tab`);
    assert.equal(c.radius, "6px", `${where}: the ⋯ has the controls' corner`); }
}
/** The same menu three ways (the ⋯, a right-click, Shift+F10), its six rows in order, and Escape back to the ⋯. */
async function checkMenu(page, name, where) {
  const byClick = await openFileMenu(page, name, "click");
  assert.deepEqual(byClick.map((r) => r.label), FILE_ROWS, `${where}: ${name}: the six, in order, none missing`);
  for (const r of byClick) if (r.off) assert.ok(r.why.length > 12, `${where}: ${name}: ${r.label} is off and says why`);
  const byRight = await openFileMenu(page, name, "right");
  assert.deepEqual(byRight, byClick, `${where}: ${name}: a right-click opens the same menu`);
  const byKeys = await openFileMenu(page, name, "keys");
  assert.deepEqual(byKeys, byClick, `${where}: ${name}: Shift+F10 opens the same menu`);
  assert.equal(await page.evaluate(() => document.activeElement?.classList.contains("dgc-menu-row")), true, `${where}: by the keyboard, the first row has the focus`);
  await page.keyboard.press("ArrowDown"); await page.keyboard.press("Escape"); await page.waitForTimeout(80);
  assert.equal((await menuRows(page)).length, 0, "Escape closes it");
  assert.equal(await fileMoreFocused(page, name), true, `${where}: ${name}: Escape puts the keyboard back on the ⋯`);
  return byClick;
}

for (const width of [300, 440, 700]) {
  test(`Work: what you attached and what the turn made each have the menu; a project file does all six, a picture says what it can't (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openWorkFiles(browser, { width });
    try {
      const cards = await fileCards(x.page);
      checkCards(cards, ["billing/totals.py", "invoice-shot.png", "differences.csv", "walkthrough.mp4"], "Work");
      assert.deepEqual([cards.find((c) => c.name === "billing/totals.py").side, cards.find((c) => c.name === "differences.csv").side], ["you", "dgc"]);
      // A file you named in your project: its real path, so everything works.
      let rows = await checkMenu(x.page, "billing/totals.py", "Work");
      assert.deepEqual(on(rows), FILE_ROWS, "a project's text file does all six");
      for (const [label, act] of [["Open", "open"], ["Open in editor", "editor"], ["Save a copy…", "save"], ["Copy", "copy"], ["Copy path", "path"], ["Reveal in file manager", "reveal"]]) {
        await openFileMenu(x.page, "billing/totals.py"); await pickRow(x.page, label);
        assert.deepEqual((await x.posted("fileAct")).at(-1), { type: "fileAct", act, file: { kind: "project", path: "billing/totals.py" } }, `${label} asks the host, naming only the file as the session named it`);
      }
      // What the turn made: the same; a video has no text to copy.
      rows = await checkMenu(x.page, "walkthrough.mp4", "Work");
      assert.deepEqual(on(rows), ["Open", "Open in editor", "Save a copy…", "Copy path", "Reveal in file manager"]);
      assert.match(why(rows, "Copy"), /Copy takes a picture or a text file/);
      await openFileMenu(x.page, "differences.csv"); await pickRow(x.page, "Reveal in file manager");
      assert.deepEqual((await x.posted("fileAct")).at(-1), { type: "fileAct", act: "reveal", file: { kind: "project", path: "out/differences.csv" } });
      // A picture you pasted is kept inside the session.
      rows = await checkMenu(x.page, "invoice-shot.png", "Work");
      assert.deepEqual(on(rows), ["Open", "Save a copy…", "Copy"]);
      for (const label of ["Open in editor", "Copy path", "Reveal in file manager"]) assert.match(why(rows, label), /kept inside its session/, label);
      const before = (await x.posted("fileAct")).length;
      await openFileMenu(x.page, "invoice-shot.png"); await pickRow(x.page, "Copy path");
      assert.equal((await x.posted("fileAct")).length, before, "a row that is off asks nothing");
      await openFileMenu(x.page, "invoice-shot.png"); await pickRow(x.page, "Save a copy…");
      const saved = (await x.posted("saveImage")).at(-1);
      assert.ok(saved && /^data:image\/png;base64,/.test(saved.data) && saved.name === "invoice-shot.png", "Save a copy… hands the picture itself to the host's save dialog");
      await openFileMenu(x.page, "invoice-shot.png"); await pickRow(x.page, "Open");
      assert.equal(await x.page.evaluate(() => !!document.querySelector(".image-viewer, #image-viewer, .dgc-image-viewer, [data-image-viewer]")?.getClientRects().length), true, "Open shows it in DGC's picture viewer");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });

  test(`ChatDGC: your attached files and the files a reply made each have the menu, through the host by the file's id (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openChatFiles(browser, { width });
    try {
      const cards = await fileCards(x.page);
      checkCards(cards, ["lease.pdf", "my-notes.txt", "rent-or-buy.docx", "numbers.md"], "ChatDGC");
      assert.deepEqual([cards.find((c) => c.name === "lease.pdf").side, cards.find((c) => c.name === "rent-or-buy.docx").side], ["you", "dgc"]);
      let rows = await checkMenu(x.page, "rent-or-buy.docx", "ChatDGC");
      assert.deepEqual(on(rows), ["Open", "Save a copy…"], "a Word file DGC keeps for the chat opens and saves");
      assert.equal(why(rows, "Copy path"), KEPT_WHY); assert.equal(why(rows, "Reveal in file manager"), KEPT_WHY);
      assert.match(why(rows, "Open in editor"), /editor/); assert.match(why(rows, "Copy"), /Copy takes a picture or a text file/);
      rows = await checkMenu(x.page, "numbers.md", "ChatDGC");
      assert.deepEqual(on(rows), ["Open", "Open in editor", "Save a copy…", "Copy"], "a text file also opens in an editor and copies its text");
      for (const [label, act] of [["Open", "open"], ["Open in editor", "editor"], ["Save a copy…", "save"], ["Copy", "copy"]]) {
        await openFileMenu(x.page, "numbers.md"); await pickRow(x.page, label);
        const said = (await x.posted("fileAct")).at(-1);
        assert.deepEqual([said.act, said.fileId, Object.keys(said).some((k) => /path/i.test(k))], [act, ATT("d"), false], `${label}: the file's id, never a path`);
      }
      rows = await checkMenu(x.page, "my-notes.txt", "ChatDGC");
      assert.deepEqual(on(rows), ["Open", "Open in editor", "Save a copy…", "Copy"]);
      await openFileMenu(x.page, "lease.pdf"); await pickRow(x.page, "Save a copy…");
      assert.deepEqual([(await x.posted("fileAct")).at(-1).act, (await x.posted("fileAct")).at(-1).fileId], ["save", ATT("a")]);
      const before = (await x.posted("fileAct")).length;
      await openFileMenu(x.page, "lease.pdf"); await pickRow(x.page, "Reveal in file manager");
      assert.equal((await x.posted("fileAct")).length, before, "a row that is off asks nothing");
      assert.deepEqual(x.errors, []);
    } finally { await x.page.close(); }
  });

  test(`a Pip's chat: the files it sent and the file you sent each have the menu, not only Save (${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const x = await openPipFiles(browser, { width });
    try {
      const cards = await fileCards(x.page);
      checkCards(cards, ["checkout-notes.md", "checkout-flow.webm", "checkout-logs-2026-11-16.zip"], "a Pip's chat");
      assert.deepEqual([cards.find((c) => c.name === "checkout-notes.md").side, cards.find((c) => c.name === "checkout-logs-2026-11-16.zip").side], ["you", "pip"]);
      let rows = await checkMenu(x.page, "checkout-logs-2026-11-16.zip", "a Pip's chat");
      assert.deepEqual(on(rows), ["Open", "Save a copy…"]);
      assert.equal(why(rows, "Copy path"), KEPT_WHY); assert.equal(why(rows, "Reveal in file manager"), KEPT_WHY);
      rows = await checkMenu(x.page, "checkout-notes.md", "a Pip's chat");
      assert.deepEqual(on(rows), ["Open", "Open in editor", "Save a copy…", "Copy"], "the text file you sent opens in an editor and copies its text");
      for (const [label, act] of [["Open", "open"], ["Open in editor", "editor"], ["Save a copy…", "save"], ["Copy", "copy"]]) {
        await openFileMenu(x.page, "checkout-notes.md"); await pickRow(x.page, label);
        assert.deepEqual((await x.posted("pipsFileAct")).at(-1), { type: "pipsFileAct", act, pip_id: PIP, message_id: "u1", index: 0 }, `${label}: the message and the file's number, never a path`);
      }
      await openFileMenu(x.page, "checkout-flow.webm"); await pickRow(x.page, "Save a copy…");
      assert.deepEqual((await x.posted("pipsFileAct")).at(-1), { type: "pipsFileAct", act: "save", pip_id: PIP, message_id: "a1", index: 0 });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}

test("one menu module: the Library's rows and the chats' rows come from media/shared/filemenu.js, and no chat's menu offers Cut or Remove", () => {
  const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), "utf8");
  const module = read("media/shared/filemenu.js");
  assert.match(module, /Reveal in file manager/);
  for (const f of ["media/library.js", "media/main.js", "media/chatdgc.js", "src/pipsClient.js"]) assert.match(read(f), /DgcFileMenu/, `${f} draws its file menu through the module`);
  assert.doesNotMatch(read("media/library.js"), /\["reveal", "Reveal in file manager"\]/, "the Library no longer keeps its own copy of the rows");
  for (const f of ["src/panel.ts", "src/chatdgc.ts"]) assert.match(read(f), /filemenu\.js/, `${f} loads it`);
  assert.match(read("src/pipsClient.js"), /shared\/filemenu\.js/);
});
