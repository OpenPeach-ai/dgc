// A note's editor tab (src/notesTab.ts, media/shared/notestab.js) in real Chromium: the document the real code builds,
// with exactly the styles and scripts it names, on the same notes store as a side bar scene. Not a *.test.mjs file.
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { readStylesheet } from "./stylesheet.mjs";
import { THEMES } from "./options-scene.mjs";
import { notesModule } from "./notes-host.mjs";

const root = new URL("../..", import.meta.url).pathname;
let loaded;
/** src/notesTab.ts, bundled against the stub `vscode` the notes host uses (globalThis.__NOTES_VSCODE). */
export async function tabModule() {
  if (loaded) return loaded;
  await notesModule();
  // (The stub's parts are there before the module reads them; a test fills them in.)
  for (const part of ["window", "ViewColumn", "Uri", "env", "workspace"]) globalThis.__NOTES_VSCODE[part] ||= {};
  const out = await build({ entryPoints: [root + "src/notesTab.ts"], bundle: true, write: false, format: "cjs", platform: "node",
    plugins: [{ name: "vscode", setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "stub" }));
      b.onLoad({ filter: /.*/, namespace: "stub" }, () => ({ contents: "module.exports = globalThis.__NOTES_VSCODE;" })); } }] });
  const mod = { exports: {} };
  new Function("module", "exports", "require", out.outputFiles[0].text)(mod, mod.exports, createRequire(import.meta.url));
  return (loaded = mod.exports);
}
/** The tab's page for note `id`, answered by `store` (a Notes). */
export async function openNoteTab(browser, store, id, { width = 1000, height = 800, theme = "dark-modern", scale = 1 } = {}) {
  const { noteTabDocument } = await tabModule();
  let html = noteTabDocument((name) => `media:${name}`, "media:", id);
  html = html.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "").replace(/<link rel="stylesheet" href="media:([^"]+)">/g, (m, name) => `<style>${readStylesheet(`${root}media/${name}`)}</style>`);
  const scripts = [...html.matchAll(/<script src="media:([^"]+)"><\/script>/g)].map((m) => readFileSync(`${root}media/${m[1]}`, "utf8"));
  html = html.replace(/<script src="media:[^"]+"><\/script>/g, "");
  const light = theme.startsWith("light"), page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  // (As the editor does: the theme's own variables on the page's root, and its kind as a class on the body.)
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((cls) => document.body.classList.add(cls), light ? "vscode-light" : "vscode-dark");
  const tell = (said) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), JSON.parse(JSON.stringify(said))).catch(() => {});
  await page.exposeFunction("__tabHost", (m) => { store.handle(m, tell); });
  const heard = store.onSaid(tell);
  await page.evaluate(() => { window.__tabPosted = []; window.__tabState = undefined; window.acquireVsCodeApi = () => ({ postMessage: (m) => { window.__tabPosted.push(m); window.__tabHost(m); }, setState: (s) => { window.__tabState = s; }, getState: () => window.__tabState }); });
  for (const script of scripts) await page.evaluate((code) => { (0, eval)(code); }, script);
  const rest = async (ms = 80) => { await page.evaluate((w) => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, w)))), ms); };
  await rest(300);
  return { page, rest, close: async () => { heard.dispose(); await page.close(); } };
}
