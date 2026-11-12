// A Pip's computer tab with its real screen, in real Chromium: the real client and its CSS, the real noVNC viewer, and a
// fake RFB server (./fake-rfb-server.mjs) on the far side of the same base64 relay the extension host runs
// (pipDesktop out, pipDesktopData in). The page sits inside the defaults VS Code gives every webview (a 20 px gutter).
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { FakeRfbServer } from "./fake-rfb-server.mjs";
import { THEMES } from "./pip-chat-scene.mjs";

const src = fileURLToPath(new URL("../../src/", import.meta.url));
let built;
/** As esbuild.js builds it for the extension: an ES module (noVNC uses top-level await), its stylesheet beside it. */
export async function bundle() {
  if (!built) {
    const out = await build({ entryPoints: [src + "pipComputerClient.js"], bundle: true, write: false, format: "esm", outdir: "dist",
      platform: "browser", target: "chrome108", loader: { ".jpg": "dataurl" }, logLevel: "silent" });
    built = { js: out.outputFiles.find((f) => f.path.endsWith(".js")).text, css: out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n") };
  }
  return built;
}
export const PIP = { id: "pip_" + "c".repeat(32), name: "Mornings", pip_type: "core" };
export const SIZES = ["1280x800", "1440x900", "1920x1080"];
const VSCODE_WEBVIEW = '<style id="_defaultStyles">@layer vscode-default{body{margin:0;padding:0 20px;font-family:var(--vscode-font-family);'
  + "font-size:var(--vscode-font-size)}::-webkit-scrollbar{width:10px;height:10px}}</style>";

// The stub extension host, in the page. window.__scene is what DGC would say; a test changes it as the story goes.
function host(PIP, scene) {
  window.__scene = scene; window.__sent = []; window.__posted = []; window.__copied = [];
  const post = (m) => window.postMessage(m, "*");
  const answers = {
    get_pip_computer: () => ({ computer: { pip_id: PIP.id, granted: true, available: true, reason: "", pending: (scene.actions || []).length, actions: scene.actions || [], ...(scene.screens ? { screen: scene.screen, screens: scene.screens } : {}) } }),
    get_pip_computer_desktop: () => ({ desktop: { pip_id: PIP.id, available: true, reason: "", install: "", using: scene.using, browser: "Chromium", chrome_install: "" } }),
    use_pip_computer_view: () => ({ view: { ok: false, error: "" } }),
    // Its Files (scene.files: the top folder), for the Files panel under the screen.
    list_pip_computer_files: (r) => ({ path: r.path, entries: r.path ? [] : scene.files || [], more: false, total_bytes: (scene.files || []).reduce((n, f) => n + (f.bytes || 0), 0) }),
    read_pip_computer_file: (r) => { const f = (scene.files || []).find((x) => x.name === r.path) || { bytes: 12 }; const big = f.bytes > 2 * 1024 * 1024;
      return { path: r.path, name: r.path.split("/").at(-1), mime: big ? "application/octet-stream" : "text/plain", bytes: f.bytes, ...(big ? { too_large: true } : { text: "buy milk\n", truncated: false }) }; },
    remove_pip_computer_file: (r) => { scene.files = (scene.files || []).filter((x) => x.name !== r.path); return { path: r.path, removed: true }; },
    set_pip_computer_screen: (r) => { scene.screen = r.size; void window.__rfb("size", r.size); return { pip_id: PIP.id, screen: r.size }; },
    // The held submits (scene.actions): an answer settles one, as DGC does, and it is gone from the next look.
    decide_pip_computer_action: (r) => { const a = scene.actions.find((x) => x.id === r.action_id); scene.actions = scene.actions.filter((x) => x !== a); return { action: { ...a, status: r.approve ? "approved" : "rejected" } }; },
    always_allow_pip_computer_action: (r) => { const a = scene.actions.find((x) => x.id === r.action_id); scene.actions = scene.actions.filter((x) => x !== a); return { action: { ...a, status: "approved" }, grant: { id: "grant_" + "1".repeat(32) } }; },
    // Stop: DGC says it is stopping, and the screen's stream closes a moment later.
    stop_pip_computer: () => { setTimeout(() => post({ type: "pipDesktopClosed", reason: "The computer's screen closed." }), 40); return { pip_id: PIP.id, stopping: true }; },
  };
  let chain = Promise.resolve();
  window.acquireVsCodeApi = () => ({ getState: () => window.__state, setState(s) { window.__state = s; }, postMessage(m) {
    if (m?.type === "pipsRequest") {
      window.__sent.push(m.request);
      const make = answers[m.request.type];
      setTimeout(() => post(make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } : { type: "pipsReply", id: m.id, ok: false, error: "Not in this scene." }), 5);
      return;
    }
    if (m?.type === "pipDesktop") {
      // The relay: the viewer's bytes go to the fake server, in order, and its answers come back as the stream's data.
      chain = chain.then(() => window.__rfb(m.op, m.data || "")).then((replies) => { for (const data of replies) post({ type: "pipDesktopData", data }); });
      window.__posted.push({ type: m.type, op: m.op, size: (m.data || "").length, ...(m.number ? { number: m.number } : {}) });
      return;
    }
    window.__posted.push(m);
    if (m?.type === "pipComputerCopy") { window.__copied.push(m.text); setTimeout(() => post({ type: "pipComputerCopied", ok: scene.copyFails !== true }), 5); }
  } });
  window.__start = () => { post({ type: "pipComputerInit", pip: PIP, desktop: true });
    post({ type: "pipsConnection", generation: 7, apiVersion: scene.api, connected: true, supported: true, enabled: true }); };
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
/**
 * Open the tab. `opts`: width, height, theme ("dark" | "light"), api, using (a Pip run has the keyboard), screen and
 * screens (what get_pip_computer says; screens: null for a DGC that says neither), actions (its held submits) and
 * motion ("reduce", the default, or "no-preference").
 * Returns the page `p`; `rfb()`, the fake server the screen is on now, and `servers`, every one it has been on;
 * `cut(text)`, the computer copying text; `scene(patch)` to change what DGC says; `errors`; `close()`.
 */
export async function openComputer(browser, opts = {}) {
  const { width = 700, height = 640, theme = "dark", api = 86, using = false, screen = "1280x800", screens = SIZES, motion = "reduce" } = opts;
  const { js, css } = await bundle();
  const t = THEMES[theme];
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8">${VSCODE_WEBVIEW}<style>${t.css}</style><style>${css}</style></head><body class="${t.kind}"><main id="app"></main>`
    + `<script>(${host})(${JSON.stringify(PIP)}, ${JSON.stringify({ api, using, screen, screens, files: opts.files || [], actions: opts.actions || [] })});</script><script type="module" src="/ext/dist/pipComputer.js"></script></body></html>`;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: motion, colorScheme: theme });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const servers = [];
  let next = screen;
  await p.exposeFunction("__rfb", (op, data) => {
    if (op === "size") { next = data; return []; }
    if (op === "open") { const [w, h] = next.split("x").map(Number); servers.push(new FakeRfbServer({ width: w, height: h, name: PIP.name })); return [b64(servers.at(-1).hello())]; }
    if (op === "send") return servers.at(-1).feed(Buffer.from(data, "base64")).map(b64);
    return [];
  });
  await p.route("https://pc.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/ext/dist/pipComputer.js") return r.fulfill({ body: js, contentType: "text/javascript" });
    if (path === "/webview/index.html") return r.fulfill({ body: page, contentType: "text/html" });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto("https://pc.test/webview/index.html", { waitUntil: "load" });
  // The client is a module that awaits (noVNC): the page's load can come before it listens. It says pipsReady when it does.
  await p.waitForFunction(() => window.__posted.some((m) => m.type === "pipsReady"));
  await p.evaluate(() => window.__start());
  // The real viewer has connected and drawn the fake server's screen.
  if (opts.wait !== false) {
    try { await p.waitForFunction(() => { const c = document.querySelector("#pc-vnc canvas"); return c && c.width > 300 && !document.querySelector("#pc-overlay .pc-overlay-note"); }); }
    catch (error) {
      // Say where it stopped: what the page shows, what it asked for, and how far the fake server got.
      const seen = await p.evaluate(() => ({ app: document.getElementById("app")?.innerText.slice(0, 300), canvas: document.querySelector("#pc-vnc canvas")?.width ?? null,
        sent: window.__sent.map((r) => r.type).join(), posted: window.__posted.map((m) => m.type + ":" + (m.op || "")).join(), hidden: document.hidden })).catch((e) => String(e));
      error.message += `\nThe screen did not open. Page: ${JSON.stringify(seen)}. Server: ${JSON.stringify(servers.map((s) => ({ phase: s.phase, messages: s.messages.map((m) => m.type).join(), drawn: s.drawn, waiting: s.buffer.length })))}. Errors: ${JSON.stringify(errors)}`;
      throw error;
    }
  }
  return { p, errors, servers, rfb: () => servers.at(-1),
    cut: (text) => p.evaluate((data) => window.postMessage({ type: "pipDesktopData", data }, "*"), b64(servers.at(-1).cutText(text))),
    scene: (patch) => p.evaluate((v) => Object.assign(window.__scene, v), patch),
    close: () => context.close() };
}
