// Download saves on the computer the editor runs on (asked 18 Nov: Download opened a folder picker of the machine
// DGC runs on, where it should be saved on the computer the editor runs on, on all surfaces). ONE module, two halves: media/shared/download.js in every page (a Blob, an object URL and a hidden
// <a download> clicked, from the page itself, which runs in the editor's own window), and src/download.ts in the host
// (the bytes handed to that page, never VS Code's save dialog, which over a remote connection browses the remote).
// In real Chromium the download is caught and its file read back; the host half is bundled against a stub `vscode`.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { chromiumOrNull } from "./support/look-probe.mjs";

const here = new URL(".", import.meta.url).pathname;
const pageJs = readFileSync(here + "../media/shared/download.js", "utf8");
const chromium = await chromiumOrNull();
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

// ---- the page's half ----------------------------------------------------------------------------------------------
test("the page module reads bytes however a host or a page holds them, and names a file safely", () => {
  const dom = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" });
  dom.window.eval(pageJs);
  const D = dom.window.DgcDownload;
  assert.ok(D, "window.DgcDownload");
  const want = [...PNG];
  assert.deepEqual([...D.bytesOf(new Uint8Array(PNG))], want, "bytes");
  assert.deepEqual([...D.bytesOf(new Uint8Array(PNG).buffer)], want, "an ArrayBuffer");
  assert.deepEqual([...D.bytesOf(`data:image/png;base64,${PNG.toString("base64")}`)], want, "a data: URI");
  assert.deepEqual([...D.bytesOf({ type: "Buffer", data: want })], want, "a Buffer's JSON form");
  // (Live, 21 Nov: VS Code hands a Uint8Array to the page as a plain list of numbers, and the page refused it, so a
  // Library download stayed on "Preparing…" and the pop-up's Download did nothing.)
  assert.deepEqual([...D.bytesOf([...want])], want, "a plain list of numbers");
  assert.deepEqual([...D.bytesOf(Object.fromEntries(want.map((n, i) => [i, n])))], want, "a typed array's JSON form");
  assert.equal(D.bytesOf([1, 2, 300]), null, "never a number that isn't a byte");
  assert.equal(D.bytesOf(["a"]), null);
  assert.equal(new TextDecoder().decode(D.bytesOf("data:text/plain,hello%20there")), "hello there", "a plain data: URI");
  assert.equal(D.bytesOf("not data"), null);
  assert.equal(D.nameOf("../../etc/passwd"), "passwd", "never a folder");
  assert.equal(D.nameOf("a\u0000b:c?.png"), "a b c .png", "no control or reserved characters");
  assert.equal(D.nameOf(""), "download");
  assert.equal(D.nameOf(".hidden"), "hidden", "never a dot file");
});

async function page(width = 600) {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width, height: 400 } });
  const p = await context.newPage();
  await p.setContent(`<!doctype html><body><button id="ask" style="margin:120px">Download</button></body>`);
  await p.addScriptTag({ content: pageJs });
  return { p, context };
}
const read = async (download) => readFileSync(await download.path());

test("a host's download is saved by the page on this computer, and \"Downloaded\" is said where it was asked", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await page();
  try {
    await p.evaluate(() => window.DgcDownload.ask(document.getElementById("ask")));
    const caught = p.waitForEvent("download");
    await p.evaluate((bytes) => window.postMessage({ type: "dgcDownload", name: "Picture 2.png", mime: "image/png", data: new Uint8Array(bytes) }, "*"), [...PNG]);
    const download = await caught;
    assert.equal(download.suggestedFilename(), "Picture 2.png");
    assert.deepEqual(await read(download), PNG, "the bytes the host handed over");
    const said = await p.waitForSelector(".dgc-download-said", { timeout: 3000 });
    assert.equal(await said.textContent(), "Downloaded");
    assert.equal(await said.getAttribute("role"), "status");
    const [note, button] = [await said.boundingBox(), await p.locator("#ask").boundingBox()];
    assert.ok(Math.abs(note.y + note.height - button.y) < 16, "just above the control that asked");
    assert.equal(await p.locator("a[data-dgc-download]").count(), 0, "the link it clicked is gone");
  } finally { await context.close(); }
});

test("what the page itself holds (a picture it shows) is saved from the page, with its type", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await page();
  try {
    const caught = p.waitForEvent("download");
    const ok = await p.evaluate((uri) => window.DgcDownload.here(document.getElementById("ask"), { name: "chart.png", data: uri }), `data:image/png;base64,${PNG.toString("base64")}`);
    assert.equal(ok, true);
    const download = await caught;
    assert.equal(download.suggestedFilename(), "chart.png");
    assert.deepEqual(await read(download), PNG);
    // A text file, too: a note's words.
    const text = p.waitForEvent("download");
    await p.evaluate(() => window.postMessage({ type: "dgcDownload", name: "Trip notes.md", mime: "text/markdown", data: new TextEncoder().encode("# Trip\nPack light.") }, "*"));
    const note = await text;
    assert.equal(note.suggestedFilename(), "Trip notes.md");
    assert.equal(String(await read(note)), "# Trip\nPack light.");
  } finally { await context.close(); }
});

test("nothing to save is said, never a broken file", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await page();
  try {
    let downloads = 0;
    p.on("download", () => { downloads++; });
    await p.evaluate(() => { window.DgcDownload.ask(document.getElementById("ask")); window.postMessage({ type: "dgcDownload", name: "x.png", data: "javascript:alert(1)" }, "*"); });
    const said = await p.waitForSelector(".dgc-download-said", { timeout: 3000 });
    assert.match(await said.textContent(), /Couldn.t download here/);
    await p.waitForTimeout(150);
    assert.equal(downloads, 0);
  } finally { await context.close(); }
});

test("a frame inside the page (a plugin's card) cannot start a download; the frame around it (the editor's) can", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await page();
  try {
    let downloads = 0;
    p.on("download", () => { downloads++; });
    await p.evaluate(() => new Promise((done) => {
      const card = document.createElement("iframe");
      card.srcdoc = `<script>parent.postMessage({ type: "dgcDownload", name: "invoice.pdf.exe", mime: "application/octet-stream", data: "data:text/plain,evil" }, "*");<\/script>`;
      card.onload = () => setTimeout(done, 200);
      document.body.append(card);
    }));
    assert.equal(downloads, 0, "a card's message is not the host's");
    assert.equal(await p.locator(".dgc-download-said").count(), 0);
    // The page inside a frame, as a webview's content is: its parent's message is the host's.
    const frame = await p.evaluateHandle(() => new Promise((done) => {
      const inner = document.createElement("iframe");
      inner.srcdoc = "<!doctype html><body></body>";
      inner.onload = () => done(inner);
      document.body.append(inner);
    }));
    const child = await (await frame.asElement()).contentFrame();
    await child.addScriptTag({ content: pageJs });
    const caught = p.waitForEvent("download");
    await p.evaluate(() => document.querySelectorAll("iframe")[1].contentWindow.postMessage({ type: "dgcDownload", name: "notes.md", mime: "text/markdown", data: "data:text/markdown,%23%20Notes" }, "*"));
    assert.equal((await caught).suggestedFilename(), "notes.md");
  } finally { await context.close(); }
});

test("the editor's frame is let in even when it isn't the page's parent (VS Code); a card's own frame never is", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await page();
  try {
    let downloads = 0;
    p.on("download", () => { downloads++; });
    // Two frames side by side: the page (with DgcDownload) and a sender that is neither the page nor its parent.
    const handle = await p.evaluateHandle(() => new Promise((done) => {
      let left = 2; const ready = () => { if (!--left) done(inner); };
      const inner = document.createElement("iframe"); inner.srcdoc = "<!doctype html><body></body>"; inner.onload = ready;
      const side = document.createElement("iframe"); side.srcdoc = "<!doctype html><body></body>"; side.onload = ready;
      document.body.append(inner, side);
    }));
    const child = await (await handle.asElement()).contentFrame();
    await child.addScriptTag({ content: pageJs });
    // A card inside the page, and a frame inside that card: neither may start one.
    await child.evaluate(() => new Promise((done) => {
      const card = document.createElement("iframe");
      card.srcdoc = `<iframe srcdoc="<script>parent.parent.postMessage({ type: 'dgcDownload', name: 'deep.exe', data: 'data:text/plain,evil' }, '*');<\/script>"></iframe>`
        + `<script>parent.postMessage({ type: "dgcDownload", name: "card.exe", data: "data:text/plain,evil" }, "*");<\/script>`;
      card.onload = () => setTimeout(done, 300);
      document.body.append(card);
    }));
    assert.equal(downloads, 0, "a card's messages are not the host's");
    const caught = p.waitForEvent("download");
    await p.evaluate(() => { const [inner, side] = document.querySelectorAll("iframe");
      side.contentWindow.eval(`parent.frames[0].postMessage({ type: "dgcDownload", name: "Lib test.docx", mime: "application/octet-stream", data: new Uint8Array([80, 75, 3, 4]) }, "*")`); });
    assert.equal((await caught).suggestedFilename(), "Lib test.docx");
  } finally { await context.close(); }
});

test("in the editor's desktop app the host saves it and only says so: Downloaded, nothing when cancelled, never a link", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await page();
  try {
    let downloads = 0;
    p.on("download", () => { downloads++; });
    await p.evaluate(() => { window.DgcDownload.ask(document.getElementById("ask")); window.postMessage({ type: "dgcDownload", name: "Lib test.docx", saved: true }, "*"); });
    assert.equal(await (await p.waitForSelector(".dgc-download-said", { timeout: 3000 })).textContent(), "Downloaded");
    await p.evaluate(() => document.querySelectorAll(".dgc-download-said").forEach((n) => n.remove()));
    await p.evaluate(() => { window.DgcDownload.ask(document.getElementById("ask")); window.postMessage({ type: "dgcDownload", name: "Lib test.docx", cancelled: true }, "*"); });
    await p.waitForTimeout(300);
    assert.equal(await p.locator(".dgc-download-said").count(), 0, "a cancelled dialog says nothing");
    await p.evaluate(() => { window.DgcDownload.ask(document.getElementById("ask")); window.postMessage({ type: "dgcDownload", name: "x.png", failed: true }, "*"); });
    assert.equal(await (await p.waitForSelector(".dgc-download-said", { timeout: 3000 })).textContent(), "Couldn’t download here");
    assert.equal(downloads, 0, "the page itself starts no download");
  } finally { await context.close(); }
});

test("in a browser a connected page still saves what it holds itself: no trip to the host", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await page();
  try {
    const caught = p.waitForEvent("download");
    const sent = await p.evaluate(() => { const got = []; window.DgcDownload.connect((m) => got.push(m));
      window.DgcDownload.here(document.getElementById("ask"), { name: "Chart.png", data: "data:image/png;base64,iVBORw0KGgo=" }); return got.length; });
    assert.equal(sent, 0);
    assert.equal((await caught).suggestedFilename(), "Chart.png");
  } finally { await context.close(); }
});

test("a page connected to its host hands what it holds to the host (a picture, a chart), and says Downloaded on its answer", async (t) => {
  if (skipOrFail(t)) return;
  const { p, context } = await page();
  try {
    let downloads = 0;
    p.on("download", () => { downloads++; });
    const sent = await p.evaluate(async () => {
      const got = [];
      window.DgcDownload.connect((m) => got.push(m), { desktop: true });
      window.DgcDownload.here(document.getElementById("ask"), { name: "../Chart 1.png", data: "data:image/png;base64,iVBORw0KGgo=", mime: "image/png" });
      window.DgcDownload.here(document.getElementById("ask"), { name: "notes.txt", data: new TextEncoder().encode("hi") });
      window.DgcDownload.here(document.getElementById("ask"), { name: "blob.bin", data: new Blob([new Uint8Array([1, 2, 3])]) });
      await new Promise((r) => setTimeout(r, 100));
      return got.map((m) => [m.type, m.name, m.mime, typeof m.data === "string" ? m.data.slice(0, 22) : Array.from(m.data)]);
    });
    assert.deepEqual(sent, [["dgcSave", "Chart 1.png", "image/png", "data:image/png;base64,"], ["dgcSave", "notes.txt", "", [104, 105]], ["dgcSave", "blob.bin", "", [1, 2, 3]]]);
    assert.equal(downloads, 0, "nothing saved by the page itself");
    await p.evaluate(() => window.postMessage({ type: "dgcDownload", name: "Chart 1.png", saved: true }, "*"));
    assert.equal(await (await p.waitForSelector(".dgc-download-said", { timeout: 3000 })).textContent(), "Downloaded");
  } finally { await context.close(); }
});

// ---- the host's half ----------------------------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), "dgc-download-host-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const world = { warnings: [], infos: [], opened: [], dialogs: [], written: [], answer: undefined, writeFails: false };
globalThis.__DGC_DL_VSCODE = {
  window: { showWarningMessage: async (m) => { world.warnings.push(String(m)); }, showInformationMessage: async (m) => { world.infos.push(String(m)); },
            showSaveDialog: async (o) => { world.dialogs.push(o); if (world.answer === undefined) throw new Error("no save dialog"); return world.answer(o); } },
  env: { asExternalUri: async (u) => u, openExternal: async (u) => { world.opened.push(u.toString()); return true; } },
  Uri: { parse: (value) => ({ toString: () => value }), file: (p) => ({ scheme: "file", fsPath: p, path: p }),
         from: ({ scheme, path }) => ({ scheme, path, fsPath: path }) },
  UIKind: { Desktop: 1, Web: 2 },
  FileType: { File: 1, Directory: 2 },
  // The editor's own file system, over this machine's (what the host reads a kept file through).
  workspace: { fs: { stat: async (u) => { const s = statSync(u.fsPath); return { type: s.isFile() ? 1 : 2, size: s.size }; }, readFile: async (u) => readFileSync(u.fsPath),
                     writeFile: async (u, bytes) => { if (world.writeFails) throw new Error("no such disk"); world.written.push([u.scheme, u.fsPath]); writeFileSync(u.fsPath.startsWith(scratch) ? u.fsPath : join(scratch, "elsewhere-" + u.fsPath.split("/").pop()), bytes); } } },
};
const bundle = join(scratch, "download.cjs");
await build({ entryPoints: [here + "../src/download.ts"], bundle: true, format: "cjs", platform: "node", outfile: bundle, logLevel: "silent",
  plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "t" })); b.onLoad({ filter: /.*/, namespace: "t" }, () => ({ contents: "module.exports = globalThis.__DGC_DL_VSCODE;", loader: "js" })); } }] });
const dl = createRequire(import.meta.url)(bundle);
after(() => { delete globalThis.__DGC_DL_VSCODE; });
const pageOf = () => { const posted = []; return { posted, page: { postMessage: (m) => { posted.push(m); return Promise.resolve(true); } } }; };

test("the host hands the page the bytes, as bytes, under a safe name and its type", async () => {
  const { posted, page } = pageOf();
  assert.equal(await dl.downloadBytes(page, "../Picture 1.png", PNG), true);
  const [m] = posted;
  assert.equal(m.type, "dgcDownload");
  assert.equal(m.name, "Picture 1.png");
  assert.equal(m.mime, "image/png");
  assert.ok(m.data instanceof Uint8Array);
  assert.deepEqual(Buffer.from(m.data), PNG);
  // A view into a pooled buffer is copied first: nothing beside it goes to the page.
  const pooled = Buffer.from("tiny");
  await dl.downloadBytes(page, "t.txt", pooled);
  assert.equal(posted[1].data.byteLength, 4);
  assert.equal(posted[1].data.buffer.byteLength, 4, "only its own bytes");
});

test("a file on this machine, and a file DGC makes, go to the page; the private folder is removed after", async () => {
  const file = join(scratch, "made.pptx");
  writeFileSync(file, "the deck");
  const { posted, page } = pageOf();
  assert.equal(await dl.downloadFile(page, file, "Q3 plan.pptx"), true);
  assert.equal(posted[0].name, "Q3 plan.pptx");
  assert.equal(String(Buffer.from(posted[0].data)), "the deck");
  let folder = "";
  assert.equal(await dl.downloadMade(page, "Report.md", async (target) => {
    folder = join(target, "..");
    assert.equal(statSync(folder).mode & 0o777, 0o700, "a folder only this user reads");
    writeFileSync(target, "# Report");
  }), true);
  assert.equal(String(Buffer.from(posted[1].data)), "# Report");
  assert.equal(existsSync(folder), false, "gone once it was handed over");
  assert.deepEqual(world.warnings, []);
});

test("asked with no page (a command), or a file too large for a page, goes to the person's own browser", async () => {
  const file = join(scratch, "clip.mp4");
  writeFileSync(file, "a video");
  world.opened.length = 0;
  assert.equal(await dl.downloadFile(undefined, file, "Clip.mp4"), true);
  assert.match(world.opened[0], /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/Clip\.mp4$/);
  const got = await fetch(world.opened[0]);
  assert.equal(got.headers.get("content-disposition"), "attachment; filename*=UTF-8''Clip.mp4");
  assert.equal(await got.text(), "a video");
  assert.equal(dl.MAX_DOWNLOAD_BYTES, 512 * 1024 * 1024, "the page's own number (media/shared/download.js)");
  assert.match(pageJs, /MAX_BYTES = 512 \* 1024 \* 1024/);
});

/** As the editor's desktop app: its own Save dialog. `remote` names a remote window (Remote-SSH). */
async function asDesktop(remote, run) {
  const vs = globalThis.__DGC_DL_VSCODE, home = process.env.HOME, store = new Map();
  const memento = { get: (k) => store.get(k), update: async (k, v) => { store.set(k, v); } };
  const fakeHome = mkdtempSync(join(scratch, "home-"));
  Object.assign(world, { dialogs: [], written: [], warnings: [], infos: [], opened: [], writeFails: false });
  vs.env.uiKind = 1; vs.env.remoteName = remote; process.env.HOME = fakeHome; dl.rememberDownloadsIn(memento);
  try { return await run({ fakeHome, store }); }
  finally { delete vs.env.uiKind; delete vs.env.remoteName; process.env.HOME = home; world.answer = undefined; dl.rememberDownloadsIn(undefined); }
}

test("in the desktop app a download is saved with the editor's own dialog, starting in Downloads, then in the last folder", async () => {
  await asDesktop(undefined, async ({ fakeHome }) => {
    const downloads = join(fakeHome, "Downloads"); execFileSync("mkdir", ["-p", downloads]);
    const chosen = join(fakeHome, "Work papers"); execFileSync("mkdir", ["-p", chosen]);
    world.answer = (o) => ({ scheme: "file", fsPath: join(chosen, "Lib test.docx"), path: join(chosen, "Lib test.docx") });
    const { posted, page } = pageOf();
    assert.equal(await dl.downloadBytes(page, "Lib test.docx", Buffer.from("PK..")), true);
    assert.equal(world.dialogs[0].saveLabel, "Download");
    assert.equal(world.dialogs[0].defaultUri.scheme, "file");
    assert.equal(world.dialogs[0].defaultUri.fsPath, join(downloads, "Lib test.docx"), "Downloads first");
    assert.equal(String(readFileSync(join(chosen, "Lib test.docx"))), "PK..");
    assert.deepEqual(posted, [{ type: "dgcDownload", name: "Lib test.docx", saved: true }], "the page is told, never handed the bytes");
    // A file DGC makes (an export) goes the same way, and the dialog starts where the last one was saved.
    world.answer = () => undefined;
    const file = join(scratch, "made.docx"); writeFileSync(file, "doc");
    assert.equal(await dl.downloadFile(page, file, "Report.docx"), true);
    assert.equal(world.dialogs[1].defaultUri.fsPath, join(chosen, "Report.docx"), "the last folder");
    assert.deepEqual(posted[1], { type: "dgcDownload", name: "Report.docx", cancelled: true });
    assert.deepEqual(world.opened, [], "a cancelled dialog opens no browser");
    // Asked from a command (no page): the editor says it.
    world.answer = (o) => ({ scheme: "file", fsPath: join(chosen, "Cmd.txt"), path: join(chosen, "Cmd.txt") });
    assert.equal(await dl.downloadBytes(undefined, "Cmd.txt", Buffer.from("x")), true);
    assert.deepEqual(world.infos, ["Downloaded “Cmd.txt”."]);
  });
});

test("in a remote window the dialog browses the person's own computer (vscode-local), never the remote one", async () => {
  await asDesktop("ssh-remote", async () => {
    world.answer = (o) => ({ scheme: "vscode-local", path: "/Users/someone/Downloads/Picture 1.png", fsPath: join(scratch, "Picture 1.png") });
    const { posted, page } = pageOf();
    assert.equal(await dl.downloadBytes(page, "Picture 1.png", PNG), true);
    assert.equal(world.dialogs[0].defaultUri.scheme, "vscode-local");
    assert.equal(world.dialogs[0].defaultUri.path, "/Picture 1.png", "its folders aren't known here before the first save");
    assert.deepEqual(world.written, [["vscode-local", join(scratch, "Picture 1.png")]], "written to that computer's disk");
    assert.deepEqual(posted, [{ type: "dgcDownload", name: "Picture 1.png", saved: true }]);
    await dl.downloadBytes(page, "Picture 2.png", PNG);
    assert.equal(world.dialogs[1].defaultUri.path, "/Users/someone/Downloads/Picture 2.png", "then where the last one went");
  });
});

test("when the editor can't save it there, the person's browser downloads it instead, and says so", async () => {
  await asDesktop("ssh-remote", async () => {
    world.answer = (o) => ({ scheme: "vscode-local", path: "/x/Clip.mp4", fsPath: "/x/Clip.mp4" });
    world.writeFails = true;
    const { posted, page } = pageOf();
    assert.equal(await dl.downloadBytes(page, "Clip.mp4", Buffer.from("a video")), true);
    assert.match(world.opened[0], /^http:\/\/127\.0\.0\.1:\d+\/[a-f0-9]{48}\/Clip\.mp4$/);
    assert.equal(await (await fetch(world.opened[0])).text(), "a video");
    assert.match(world.infos[0], /^Downloading “Clip\.mp4” in your browser \(1 KB\)\.$/);
    assert.deepEqual(posted, [], "nothing said in the page: the browser has it");
  });
});

test("a page's own file (dgcSave) is saved like any download; anything that isn't one is left to the router", async () => {
  const { posted, page } = pageOf();
  assert.equal(dl.takeSave(page, { type: "other" }), false);
  assert.equal(dl.takeSave(page, null), false);
  // In a browser: back to the page as bytes, for it to save.
  assert.equal(dl.takeSave(page, { type: "dgcSave", name: "../Chart 1.png", data: "data:image/png;base64," + PNG.toString("base64") }), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(posted[0].name, "Chart 1.png");
  assert.equal(posted[0].mime, "image/png");
  assert.deepEqual(Buffer.from(posted[0].data), PNG);
  assert.equal(dl.takeSave(page, { type: "dgcSave", name: "n.txt", data: [104, 105] }), true);
  assert.equal(dl.takeSave(page, { type: "dgcSave", name: "bad.bin", data: "javascript:alert(1)" }), true);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(String(Buffer.from(posted[1].data)), "hi");
  assert.deepEqual(posted[2], { type: "dgcDownload", name: "bad.bin", failed: true });
  // In the desktop app: the dialog.
  await asDesktop(undefined, async ({ fakeHome }) => {
    world.answer = () => ({ scheme: "file", fsPath: join(fakeHome, "Chart.png"), path: join(fakeHome, "Chart.png") });
    const two = pageOf();
    dl.takeSave(two.page, { type: "dgcSave", name: "Chart.png", data: Array.from(PNG) });
    await new Promise((r) => setTimeout(r, 100));
    assert.deepEqual(readFileSync(join(fakeHome, "Chart.png")), PNG);
    assert.deepEqual(two.posted, [{ type: "dgcDownload", name: "Chart.png", saved: true }]);
  });
});

test("every page that saves what it holds hands it to its host, and every host takes it", () => {
  const src = (f) => readFileSync(here + "../" + f, "utf8");
  for (const f of ["media/main.js", "media/chatdgc.js", "src/pipComputerClient.js", "src/pipsClient.js"]) assert.match(src(f), /DgcDownload\?\.connect\(/, f);
  assert.match(src("src/panel.ts"), /if \(takeSave\(view\.webview, msg\)\) return;/);
  assert.match(src("src/chatdgc.ts"), /if \(takeSave\(tab\.panel\.webview, message\)\) return;/);
  assert.match(src("src/pipsView.ts"), /if \(takeSave\(\(m\) => this\.post\(m, surface\), message\)\) return;/);
  assert.match(src("src/extension.ts"), /rememberDownloadsIn\(context\.globalState\)/);
  // An artifact card's Download marks itself, so "Downloaded" is said beside it (not at the top of the page).
  for (const f of ["media/main.js", "media/chatdgc.js"]) assert.match(src(f), /DgcDownload\?\.ask\(button\);\s+vscode\.postMessage\(\{ type: "artifactExport"/, f);
});

test("a folder of notes is one .zip of their Markdown files, which unzips to them", () => {
  const zip = dl.zipFiles([{ name: "Trips.md", bytes: Buffer.from("# Trips\n") }, { name: "Recipes.md", bytes: Buffer.from("Soup") }]);
  const path = join(scratch, "notes.zip");
  writeFileSync(path, zip);
  const listed = execFileSync("python3", ["-I", "-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); z.testzip(); print('|'.join(n + '=' + z.read(n).decode() for n in z.namelist()))", path]).toString().trim();
  assert.equal(listed, "Trips.md=# Trips\n|Recipes.md=Soup");
});

test("every save dialog left in the extension is for a place in the project or on this machine, never a person's copy", () => {
  // Decided: every Download and Save a copy saves on the person's own computer. The dialog stays only where the place IS
  // the project: Save to project….
  const src = here + "../src/";
  const found = [];
  for (const name of readdirSync(src).filter((n) => /\.(ts|js)$/.test(n))) {
    const text = readFileSync(src + name, "utf8");
    for (const m of text.matchAll(/showSaveDialog\(\{([\s\S]{0,300})/g)) found.push(`${name}: ${m[1].replace(/\s+/g, " ")}`);
  }
  const kept = found.filter((f) => /saveLabel: "Save to project"/.test(f));
  // (And the one for a person's copy, in the desktop app: it starts on the person's own disk, src/download.ts.)
  const download = found.filter((f) => /^download\.ts: .*saveLabel: "Download", defaultUri: dialogStart\(name\)/.test(f));
  assert.equal(download.length, 1, "the desktop app's Download dialog");
  assert.deepEqual(found.filter((f) => !kept.includes(f) && !download.includes(f)), [], "a save dialog for a copy of a file");
  assert.equal(kept.length, 3, `the three that stay, all Save to project…: ${found.join("\n")}`);
});

test("Notes' export: a note is a .md download from the page that asked, and a folder of notes one .zip", async () => {
  const notesBundle = join(scratch, "notesTab.cjs");
  await build({ entryPoints: [here + "../src/notesTab.ts"], bundle: true, format: "cjs", platform: "node", outfile: notesBundle, logLevel: "silent",
    plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "t" })); b.onLoad({ filter: /.*/, namespace: "t" }, () => ({ contents: "module.exports = globalThis.__DGC_DL_VSCODE;", loader: "js" })); } }] });
  const { notesEnv } = createRequire(import.meta.url)(notesBundle);
  const env = notesEnv({ open() {} }), heard = [];
  assert.equal(await env.saveFile({ name: "Trip notes.md", text: "# Trip\n", locked: false }, (m) => heard.push(m)), true);
  assert.deepEqual([heard[0].type, heard[0].name, heard[0].mime, String(Buffer.from(heard[0].data))], ["dgcDownload", "Trip notes.md", "text/markdown", "# Trip\n"]);
  const zip = await env.saveFolder({ name: "Trips", files: [{ name: "Goa.md", text: "Beach" }, { name: "Pune.md", text: "Hills" }], locked: false }, (m) => heard.push(m));
  assert.equal(zip, "Trips.zip", "the name it is said under");
  assert.deepEqual([heard[1].name, heard[1].mime], ["Trips.zip", "application/zip"]);
  const path = join(scratch, "Trips.zip");
  writeFileSync(path, Buffer.from(heard[1].data));
  const listed = execFileSync("python3", ["-I", "-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); print('|'.join(n + '=' + z.read(n).decode() for n in z.namelist()))", path]).toString().trim();
  assert.equal(listed, "Goa.md=Beach|Pune.md=Hills");
});
