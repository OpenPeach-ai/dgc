// The artifact screens as they ship, for the tests and the captures: src/artifacts.ts bundled against a stub `vscode`
// (its artifactDocument is the panel's real page), the page's own stylesheets and scripts inlined in order, and real
// artifacts from the backend (test/support/artifact-fixture.py: dgc/artifact_slides, _sheet and _dashboard, with DGC's
// own page of each). Not a *.test.mjs file.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { pickPython } from "./panel-live.mjs";
import { THEMES } from "./options-scene.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const extensionRoot = resolve(here, "..", "..");
export const repoRoot = resolve(extensionRoot, "..", "..");
export { THEMES };

/** The vscode module the bundle sees: globalThis.__DGC_ART_VSCODE, which a test sets as it needs. */
let bundled;
export function artifactsModule() {
  if (bundled) return bundled;
  const out = mkdtempSync(join(tmpdir(), "dgc-artifacts-build-"));
  try {
    // Synchronous (a scene is set up inside a test): no plugins, so `vscode` is left external and then pointed at the stub.
    const code = buildSync({
      entryPoints: [join(extensionRoot, "src/artifacts.ts")], bundle: true, format: "cjs", platform: "node", target: "node18",
      write: false, external: ["vscode"], logLevel: "silent",
    }).outputFiles[0].text.replace(/require\("vscode"\)/g, "(globalThis.__DGC_ART_VSCODE || {})");
    writeFileSync(join(out, "artifacts.cjs"), code);
    bundled = createRequire(import.meta.url)(join(out, "artifacts.cjs"));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
  return bundled;
}

let fixtureCache;
/** Real artifacts and DGC's pages of them; null when no Python here imports this checkout's dgc. */
export function fixtures() {
  if (fixtureCache !== undefined) return fixtureCache;
  const python = pickPython();
  if (!python) { fixtureCache = null; return null; }
  const folder = mkdtempSync(join(tmpdir(), "dgc-artifact-fixture-"));
  try {
    const run = spawnSync(python, [join(here, "artifact-fixture.py"), folder], { cwd: repoRoot, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, PYTHONPATH: repoRoot, HOME: folder } });
    if (run.status !== 0) throw new Error(`artifact-fixture.py failed: ${run.stderr}`);
    fixtureCache = JSON.parse(run.stdout);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
  return fixtureCache;
}

const read = (name) => readFileSync(join(extensionRoot, name), "utf8");
const codicon = () => read("media/codicon.css").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
  `url("data:font/ttf;base64,${readFileSync(join(extensionRoot, "media/codicon.ttf")).toString("base64")}")`);

let pageCache;
/** The panel's page as artifactDocument writes it, its stylesheets inlined and its scripts held back (each test defines
 *  acquireVsCodeApi first, then runs them in the page's own order). */
export function panelPage() {
  if (pageCache) return pageCache;
  const { artifactDocument } = artifactsModule();
  const html = artifactDocument((name) => name, "data:", "TESTNONCE");
  const scripts = [...html.matchAll(/<script nonce="TESTNONCE" src="(media\/[\w.]+\.js)"><\/script>/g)].map((m) => m[1]);
  const styles = [...html.matchAll(/<link rel="stylesheet" href="(media\/[\w.]+\.css)">/g)].map((m) => m[1]);
  const inline = (name) => (name === "media/codicon.css" ? codicon() : read(name).replace(/@import[^;]*;/, ""));
  const page = html.replace(/<link rel="stylesheet" href="media\/[\w.]+\.css">/g, "")
    .replace("</head>", `${styles.map((s) => `<style>${inline(s)}</style>`).join("")}</head>`)
    .replace(/<script nonce="TESTNONCE" src="media\/[\w.]+\.js"><\/script>/g, "");
  pageCache = { html: page, js: scripts.map(read).join("\n;\n"), scripts };
  return pageCache;
}

/** The panel in Chromium at a size and theme; `kind` picks a fixture (slides, sheet, dashboard, page). */
export async function openPanel(browser, { width = 1100, height = 760, theme = "dark-modern", kind = "slides", frameUrl = "", fixture } = {}) {
  const data = fixture || fixtures();
  const { html, js } = panelPage();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark"), theme);
  await page.evaluate((code) => {
    window.__posted = []; window.__state = undefined;
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => window.__state, setState(s) { window.__state = s; } });
    eval(code);
  }, js);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => !t || m.type === t), type);
  const clearPosted = () => page.evaluate(() => { window.__posted = []; });
  const one = data?.[kind];
  if (one) {
    await send({ type: "init", id: one.view.id });
    await send({ type: "detail", artifact: one.view, content: one.content ?? null, state: one.state ?? null,
                 offer: { version: 1, types: ["page", "doc", "slides", "sheet", "dashboard"], outputs: ["auto", "document", "slides", "spreadsheet", "page", "dashboard"],
                          exports: { doc: ["docx", "pdf", "md"], slides: ["pptx", "pdf", "html"], sheet: ["xlsx", "csv"], dashboard: ["html"], page: ["html", "zip"] } } });
    if (one.html) await send({ type: "render", html: one.html, version: one.view.version });
    if (kind === "page" && frameUrl) await send({ type: "frame", url: frameUrl, version: one.view.version });
  }
  return { page, send, posted, clearPosted, errors, data: one };
}

/** Wait for every frame in the page to have drawn (a srcdoc frame loads on its own). */
export async function framesLoaded(page) {
  await page.evaluate(() => Promise.all([...document.querySelectorAll("iframe")].map((f) => new Promise((resolve) => {
    if (f.contentDocument?.readyState === "complete" && f.dataset.loadedOnce) return resolve();
    f.addEventListener("load", () => { f.dataset.loadedOnce = "1"; resolve(); }, { once: true });
    setTimeout(resolve, 1500);
  }))));
}
