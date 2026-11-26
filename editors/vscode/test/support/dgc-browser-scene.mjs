// DGC Browser's own screen in real Chromium: the real tab (src/dgcBrowserTab.js) and its CSS, the real noVNC viewer, and
// a fake RFB server (./fake-rfb-server.mjs) that takes the size a viewer asks for, as DGC Browser's own screen does, on
// the far side of the base64 relay the extension host runs (dgcBrowserScreen out, dgcBrowserScreenData in). The page
// sits inside the defaults VS Code gives every webview (a 20 px gutter, 10 px scroll bars), as a Pip computer's tab does
// in ./pip-computer-scene.mjs.
//
// DGC's answer to `use_dgc_browser_view {op: size}` is the supervisor's (dgc/dgc_browser.py): Chrome's window at the
// tab's size where Chrome can, never narrower than Chrome's own minimum (500 px, measured with Chrome 158 on a screen
// with no window manager), and the screen as large as both.
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { FakeRfbServer } from "./fake-rfb-server.mjs";
import { THEMES } from "./pip-chat-scene.mjs";

const src = process.env.DGC_PIPS_SRC ? process.env.DGC_PIPS_SRC + "/" : fileURLToPath(new URL("../../src/", import.meta.url));
let built;
export async function bundle() {
  if (!built) {
    const out = await build({ entryPoints: [src + "dgcBrowserTab.js"], bundle: true, write: false, format: "esm", outdir: "dist",
      platform: "browser", target: "chrome108", logLevel: "silent" });
    built = { js: out.outputFiles.find((f) => f.path.endsWith(".js")).text, css: out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n") };
  }
  return built;
}
export const CHROME_MIN_WIDTH = 500;
const VSCODE_WEBVIEW = '<style id="_defaultStyles">@layer vscode-default{body{margin:0;padding:0 20px;font-family:var(--vscode-font-family);'
  + "font-size:var(--vscode-font-size)}::-webkit-scrollbar{width:10px;height:10px}}</style>";

/** The supervisor's answer to a size: the page's size kept within what DGC takes, Chrome's window at it but never under its
 *  minimum width, and the screen in Chrome's pixels as large as both. `screen: false`: an older DGC that says only its scale. */
export function dgcSize(width, height, { scale = 1, screen = true } = {}) {
  const own = [Math.max(320, Math.min(3840, width)), Math.max(240, Math.min(2400, height))];
  const window = [Math.max(CHROME_MIN_WIDTH, own[0]), own[1]];
  return { ok: true, own: true, current: "T1", url: "", title: "", tabs: [], scale,
    ...(screen ? { screen: { width: Math.max(own[0], window[0]) * scale, height: Math.max(own[1], window[1]) * scale } } : {}) };
}

function host(scene) {
  window.__scene = scene; window.__sent = []; window.__posted = []; window.__states = [];
  const post = (m) => window.postMessage(m, "*");
  window.__state = scene.state ?? undefined;
  let chain = Promise.resolve();
  window.acquireVsCodeApi = () => ({ getState: () => window.__state, setState(s) { window.__state = s; window.__states.push(JSON.stringify(s ?? null)); }, postMessage(m) {
    if (m?.type === "pipsRequest") {
      window.__sent.push(JSON.parse(JSON.stringify(m.request)));
      const r = m.request;
      const result = r.op === "size" ? window.__dgcSize(r.width, r.height, { scale: scene.scale, screen: scene.screen }) : { ok: true, own: true, current: "T1", url: "", title: "", tabs: [] };
      setTimeout(() => post({ type: "pipsReply", id: m.id, ok: true, result }), 5);
      return;
    }
    if (m?.type === "dgcBrowserScreen") {
      chain = chain.then(() => window.__rfb(m.op, m.data || "")).then((replies) => { for (const data of replies) post({ type: "dgcBrowserScreenData", data }); });
      window.__posted.push({ type: m.type, op: m.op });
      return;
    }
    window.__posted.push(JSON.parse(JSON.stringify(m ?? null)));
    if (m?.type === "pipsReady") setTimeout(() => {
      post({ type: "dgcBrowserInit", own: true, screen: true });
      post({ type: "pipsConnection", generation: 1, apiVersion: 112, connected: true, supported: true, enabled: true });
    }, 5);
  } });
}

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
/**
 * Open DGC Browser's own screen. `opts`: width, height, theme, start (the screen's size when it opens: "1280x800"),
 * scale (what DGC says Chrome draws at), screen (false: an older DGC that answers no screen size), state (what the tab
 * kept: {fit}), init (a script run first in the page: a stand-in viewer).
 * Returns the page `p`, `rfb()` (the fake server the screen is on), `errors`, `close()`.
 */
export async function openDgcBrowser(browser, opts = {}) {
  const { width = 900, height = 640, theme = "dark", start = "1280x800", scale = 1, screen = true, state } = opts;
  const { js, css } = await bundle();
  const t = THEMES[theme];
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8">${VSCODE_WEBVIEW}<style>${t.css}</style><style>${css}</style></head><body class="${t.kind}"><main id="app"></main>`
    + `<script>window.__dgcSize=${dgcSize.toString()};const CHROME_MIN_WIDTH=${CHROME_MIN_WIDTH};(${host})(${JSON.stringify({ scale, screen, state: state ?? null })});</script>`
    + `<script type="module" src="/ext/dist/dgcBrowserTab.js"></script></body></html>`;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", colorScheme: theme });
  const p = await context.newPage();
  if (opts.init) await p.addInitScript(opts.init);
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  const servers = [];
  await p.exposeFunction("__rfb", (op, data) => {
    if (op === "open") { const [w, h] = start.split("x").map(Number); servers.push(new FakeRfbServer({ width: w, height: h, name: "DGC Browser", resizable: true })); return [b64(servers.at(-1).hello())]; }
    if (op === "send") return servers.at(-1).feed(Buffer.from(data, "base64")).map(b64);
    return [];
  });
  await p.route("https://yb.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/ext/dist/dgcBrowserTab.js") return r.fulfill({ body: js, contentType: "text/javascript" });
    if (path === "/webview/index.html") return r.fulfill({ body: page, contentType: "text/html" });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto("https://yb.test/webview/index.html", { waitUntil: "load" });
  return { p, errors, servers, rfb: () => servers.at(-1), close: () => context.close() };
}

/** Where the screen is and how it is drawn: the room the viewer has (its own box, scroll bars not counted), the canvas
 *  (its pixels and its size on the page), whether the room scrolls, and the page's own. */
export const viewOf = (p, sel = ".yb-vnc canvas") => p.evaluate((sel) => {
  const box = (e) => { if (!e) return null; const r = e.getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
  const canvas = document.querySelector(sel), room = canvas?.parentElement;
  return { view: [innerWidth, innerHeight], pixels: canvas ? [canvas.width, canvas.height] : null, canvas: box(canvas), outer: box(room?.parentElement), room: room ? [room.clientWidth, room.clientHeight] : null,
    scrolls: room ? [room.scrollWidth > room.clientWidth + 1, room.scrollHeight > room.clientHeight + 1] : null,
    pageScrolls: document.documentElement.scrollWidth > innerWidth + 1 || document.documentElement.scrollHeight > innerHeight + 1 };
}, sel);
