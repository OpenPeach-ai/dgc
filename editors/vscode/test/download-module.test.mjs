// Download saves on the computer the editor runs on (his asks, 18 Nov: Download opened a folder picker of the machine
// DGC runs on, where he wanted it saved on the computer his editor runs on, on all surfaces). ONE module, two halves: media/shared/download.js in every page (a Blob, an object URL and a hidden
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

// ---- the host's half ----------------------------------------------------------------------------------------------
const scratch = mkdtempSync(join(tmpdir(), "dgc-download-host-"));
after(() => rmSync(scratch, { recursive: true, force: true }));
const world = { warnings: [], infos: [], opened: [] };
globalThis.__DGC_DL_VSCODE = {
  window: { showWarningMessage: async (m) => { world.warnings.push(String(m)); }, showInformationMessage: async (m) => { world.infos.push(String(m)); },
            showSaveDialog: async () => { throw new Error("no save dialog"); } },
  env: { asExternalUri: async (u) => u, openExternal: async (u) => { world.opened.push(u.toString()); return true; } },
  Uri: { parse: (value) => ({ toString: () => value }), file: (p) => ({ scheme: "file", fsPath: p, path: p }) },
  FileType: { File: 1, Directory: 2 },
  // The editor's own file system, over this machine's (what the host reads a kept file through).
  workspace: { fs: { stat: async (u) => { const s = statSync(u.fsPath); return { type: s.isFile() ? 1 : 2, size: s.size }; }, readFile: async (u) => readFileSync(u.fsPath) } },
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

test("a folder of notes is one .zip of their Markdown files, which unzips to them", () => {
  const zip = dl.zipFiles([{ name: "Trips.md", bytes: Buffer.from("# Trips\n") }, { name: "Recipes.md", bytes: Buffer.from("Soup") }]);
  const path = join(scratch, "notes.zip");
  writeFileSync(path, zip);
  const listed = execFileSync("python3", ["-I", "-c", "import sys, zipfile; z = zipfile.ZipFile(sys.argv[1]); z.testzip(); print('|'.join(n + '=' + z.read(n).decode() for n in z.namelist()))", path]).toString().trim();
  assert.equal(listed, "Trips.md=# Trips\n|Recipes.md=Soup");
});

test("every save dialog left in the extension is for a place in the project or on this machine, never a person's copy", () => {
  // His call: every Download and Save a copy saves on the person's own computer. The dialog stays only where the place IS
  // the project: Save to project….
  const src = here + "../src/";
  const found = [];
  for (const name of readdirSync(src).filter((n) => /\.(ts|js)$/.test(n))) {
    const text = readFileSync(src + name, "utf8");
    for (const m of text.matchAll(/showSaveDialog\(\{([\s\S]{0,300})/g)) found.push(`${name}: ${m[1].replace(/\s+/g, " ")}`);
  }
  const kept = found.filter((f) => /saveLabel: "Save to project"/.test(f));
  assert.deepEqual(found.filter((f) => !kept.includes(f)), [], "a save dialog for a copy of a file");
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
