// The real Settings page (src/settingsClient.js, src/settingsFields.js, src/settings.css) in Chromium, with a small
// stand-in for the extension: it hands the page its config (with what `extra` adds), answers Running sessions with
// `running`, and takes a Save the way DGC does. Shared by stuck-holder.test.mjs, dev-mode-tools.test.mjs and the
// pictures (render-editor-batch1.mjs). Not a *.test.mjs file.
import { build } from "esbuild";

const root = new URL("../..", import.meta.url).pathname, src = root + "src/";
let made;
async function sources() {
  if (made) return made;
  const bundled = await build({ entryPoints: [src + "settingsClient.js"], bundle: true, write: false, format: "iife", outdir: "out",
    platform: "browser", target: "chrome108", loader: { ".ico": "dataurl", ".png": "dataurl", ".svg": "dataurl" } });
  const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
  const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
  const view = await build({ entryPoints: [src + "settingsView.ts"], bundle: true, write: false, format: "cjs", platform: "node" });
  const viewModule = { exports: {} };
  new Function("module", "exports", view.outputFiles[0].text)(viewModule, viewModule.exports);
  return (made = { js, css, skeleton: viewModule.exports.settingsDocument("SCRIPT", "STYLE", "") });
}
export const THEMES = {
  dark: ["vscode-dark", "--vscode-editor-background:#1f1f1f;--vscode-sideBar-background:#181818;--vscode-foreground:#cccccc;--vscode-editor-foreground:#cccccc;--vscode-descriptionForeground:#9d9d9d;--vscode-input-background:#313131;--vscode-errorForeground:#f85149;--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px"],
  light: ["vscode-light", "--vscode-editor-background:#ffffff;--vscode-sideBar-background:#f8f8f8;--vscode-foreground:#3b3b3b;--vscode-editor-foreground:#3b3b3b;--vscode-descriptionForeground:#3b3b3b;--vscode-input-background:#ffffff;--vscode-errorForeground:#f85149;--vscode-font-family:system-ui,sans-serif;--vscode-font-size:13px"],
};
/** DGC's own table of capacity limits (dgc/dev_mode.py), as the extension hands it to the page. */
export const DEV_TABLE = [
  { name: "pips_parallel_runs", label: "Pip runs at once (all Pips)", default: 4, ceiling: 32, cost: "Each run is a model call and, with a computer, its sandbox: memory and model load add up." },
  { name: "pip_computers", label: "Computers per Pip", default: 3, ceiling: 3, cost: "Each running computer: about 0.5 to 1 GB of memory and a browser." },
  { name: "monitors_per_chat", label: "Monitors per chat", default: 4, ceiling: 4, cost: "Each is a process DGC watches; its output can wake the chat." },
];
const host = (extra, running) => `(${function (extra, running) {
  const config = { type: "config", mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", model: "qwen3:8b", api_mode: "auto", max_parallel_tasks: 4,
    context_size: 65536, subagent_context_size: 0, turn_token_budget: 0, search: "duckduckgo", search_providers: ["duckduckgo"], search_keys: {}, ...extra };
  window.__posted = [];
  const say = (m) => setTimeout(() => window.postMessage(m, "*"), 1);
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    window.__posted.push(JSON.parse(JSON.stringify(m)));
    if (m.type === "ready") { say({ type: "event", event: config }); say({ type: "dockSettings", show: "always", most: 8, size: 34 }); }
    if (m.type === "listRunning") say({ type: "running", items: running });
    if (m.type === "saveSettings") setTimeout(() => {
      // As the extension answers: DGC's config says the settings it was sent, and the warning is remembered once shown.
      const said = { dev_mode: m.values.dev_mode === true, dev_limits: m.values.dev_limits || {}, dev_mode_warned: window.__posted.some((x) => x.type === "devModeWarned") || config.dev_mode_warned === true };
      if ("dev_mode_tools" in m.values) said.dev_mode_tools = m.values.dev_mode_tools === true;
      window.postMessage({ type: "event", event: { ...config, ...said } }, "*");
      window.postMessage({ type: "settingsSaved", ok: true }, "*"); window.postMessage({ type: "settingsSaveFinished" }, "*");
    }, 1);
  } });
}})(${JSON.stringify(extra)}, ${JSON.stringify(running)});`;

/** Opens Settings on `section` ("dev", "running", ...). extra: what the config says besides the usual; running: the
 *  Running sessions rows the host answers with; zone: the page's time zone (a row's "since 12:00" is the reader's clock). */
export async function openSettings(browser, { extra = {}, running = [], theme = "dark", width = 900, height = 900, section = "general", scale = 1, zone = "UTC" } = {}) {
  const { js, css, skeleton } = await sources();
  const html = skeleton.replace(/<meta http-equiv="Content-Security-Policy"[^>]*>/, "")
    .replace("<head>", `<head><style>:root{${THEMES[theme][1]}}body{margin:0}</style>`)
    .replace('<link rel="stylesheet" href="STYLE">', () => `<style>${css}</style>`).replace("<body>", `<body class="${THEMES[theme][0]}">`)
    .replace('<script src="SCRIPT"></script>', () => `<script>${host(extra, running)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script>`);
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, timezoneId: zone }), page = await context.newPage();
  page.setDefaultTimeout(15000);
  const errors = []; page.on("pageerror", (e) => errors.push(String(e)));
  await page.route("https://settings.test/**", (r) => r.fulfill({ body: html, contentType: "text/html" }));
  await page.goto("https://settings.test/view");
  await page.waitForSelector("#mode");
  if (section !== "general") {
    // (At a narrow width the sections are behind the page's own menu button.)
    const nav = page.locator(`[data-nav="${section}"]`);
    if (!(await nav.isVisible())) await page.locator("#nav-toggle, .nav-toggle, [data-nav-toggle]").first().click().catch(() => {});
    await nav.click();
  }
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
  const saved = () => page.evaluate(() => window.__posted.filter((m) => m.type === "saveSettings").at(-1)?.values);
  const rest = (ms = 80) => page.evaluate((n) => new Promise((done) => requestAnimationFrame(() => setTimeout(done, n))), ms);
  return { page, errors, posted, saved, rest, close: () => context.close() };
}

/** Settings › Running sessions with `items`, and each row as it is on screen. */
export async function openRunning(browser, { items = [], ...more } = {}) {
  const x = await openSettings(browser, { running: items, section: "running", ...more });
  await x.page.waitForSelector(".running-sessions");
  const rows = () => x.page.evaluate(() => [...document.querySelectorAll(".running-sessions .row")].map((row) => {
    const button = row.querySelector("button"), cs = button ? getComputedStyle(button) : null;
    return { title: row.querySelector("strong")?.textContent || "", summary: row.querySelector(".summary")?.textContent || "", summaryCut: (() => { const n = row.querySelector(".summary"); return !!n && n.scrollWidth > n.clientWidth + 1; })(), description: row.querySelector(".description")?.textContent || "",
      buttons: [...row.querySelectorAll("button")].map((b) => b.textContent), stuck: row.classList.contains("stuck"),
      buttonRadius: cs?.borderTopLeftRadius || "", buttonHeight: button ? Math.round(button.getBoundingClientRect().height) : 0, left: Math.round(row.querySelector(".copy").getBoundingClientRect().left) };
  }));
  return { ...x, rows };
}
