// The computer tab in real Chromium, served the way the editor serves it: an ES module (noVNC needs
// one) from dist/, the Pip's sprite and wallpaper from media/. A module script has no
// document.currentScript, and the face's sprite resolved against the page instead: the founder's
// computer tab showed Chromium's broken-image picture where the Pip's face belongs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const src = fileURLToPath(new URL("../src/", import.meta.url));
// As esbuild.js builds it for the extension.
const out = await build({ entryPoints: [src + "pipComputerClient.js"], bundle: true, write: false, format: "esm", outdir: "dist",
  platform: "browser", target: "chrome108", loader: { ".jpg": "dataurl" },
  alias: { "@novnc/novnc": fileURLToPath(new URL("./support/novnc-stub.mjs", import.meta.url)) } });
const js = out.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const host = `(${function () {
  const PIP = { id: "pip_" + "s".repeat(32), name: "Gmail", pip_type: "scout" };
  const answers = { get_pip_computer: () => ({ computer: { pip_id: PIP.id, granted: true, available: true, reason: "", pending: 0, actions: [] } }),
    use_pip_computer_view: () => ({ view: { ok: false, error: "The browser is not open." } }),
    get_pip_computer_desktop: () => ({ desktop: { pip_id: PIP.id, available: false, reason: "No desktop here.", install: "", using: false, browser: "Chromium", chrome_install: "" } }) };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    const make = m?.type === "pipsRequest" && answers[m.request.type];
    if (make) setTimeout(() => window.postMessage({ type: "pipsReply", id: m.id, ok: true, result: make(m.request) }, "*"), 5);
  } });
  setTimeout(() => { window.postMessage({ type: "pipComputerInit", pip: PIP, desktop: true }, "*");
    window.postMessage({ type: "pipsConnection", generation: 7, apiVersion: 43, connected: true, supported: true, enabled: true }, "*"); }, 10);
}})();`;
const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app"></main>`
  + `<script>${host}</script><script type="module" src="/ext/dist/pipComputer.js"></script></body></html>`;

test("the computer tab draws the Pip's own face (its sprite loads from the extension), on DGC's wallpaper", async (t) => {
  if (skipOrFail(t)) return;
  const context = await browser.newContext({ viewport: { width: 860, height: 700 } });
  const p = await context.newPage();
  const loaded = [];
  await p.route("https://pc.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/ext/dist/pipComputer.js") return r.fulfill({ body: js, contentType: "text/javascript" });
    if (path.startsWith("/ext/media/")) {
      loaded.push(path);
      return r.fulfill({ body: readFileSync(new URL(".." + path.slice(4), import.meta.url)), contentType: "image/webp" });
    }
    if (path === "/webview/index.html") return r.fulfill({ body: page, contentType: "text/html" });
    return r.fulfill({ status: 404, body: "" });
  });
  try {
    await p.goto("https://pc.test/webview/index.html");
    // Attached, not "visible": an SVG <image> lays out at zero size until its picture arrives, and
    // under a loaded machine that took past the default wait. The fetch is checked below.
    await p.waitForSelector(".pc-face .dgc-plush image", { state: "attached", timeout: 60000 });
    const href = await p.evaluate(() => {
      const image = document.querySelector(".pc-face .dgc-plush image");
      return new URL(image.getAttribute("href"), document.baseURI).pathname;
    });
    assert.equal(href, "/ext/media/pips/plush-bodies.webp", "beside the extension's files, not the page");
    for (let i = 0; i < 400 && !loaded.includes("/ext/media/pips/plush-bodies.webp"); i++) await p.waitForTimeout(50);
    assert.ok(loaded.includes("/ext/media/pips/plush-bodies.webp"), `the sprite was fetched (${loaded})`);
    const desktop = await p.evaluate(() => {
      const d = document.querySelector(".pc-desktop"), s = getComputedStyle(d);
      return { image: s.backgroundImage.slice(0, 30), windows: document.querySelectorAll(".pc-window").length };
    });
    assert.match(desktop.image, /^url\("data:image\/jpeg;base64,/, "DGC's wallpaper, carried in the stylesheet");
    assert.equal(desktop.windows, 0, "a bare desktop: nothing opens by itself");
  } finally { await context.close(); }
});
