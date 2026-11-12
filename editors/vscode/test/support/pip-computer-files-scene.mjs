// A Pip computer tab's Files panel in real Chromium: the real client and its CSS (the bundle pip-computer-scene.mjs builds),
// inside the defaults VS Code gives every webview. No screen stream here: the tab is the desktop with its dock, and Files
// opens in a window from it. The stub host answers the Files commands from window.__scene and records what the page
// posts (window.__posted); a test plays the extension host's side of Add file… and Save to this computer… with say().
import { bundle, PIP } from "./pip-computer-scene.mjs";
import { THEMES } from "./pip-chat-scene.mjs";

export { PIP };
const VSCODE_WEBVIEW = '<style id="_defaultStyles">@layer vscode-default{body{margin:0;padding:0 20px;font-family:var(--vscode-font-family);'
  + "font-size:var(--vscode-font-size)}::-webkit-scrollbar{width:10px;height:10px}}</style>";
export const FILES = [{ name: "Downloads", kind: "folder", bytes: null, modified: 1 }, { name: "notes.txt", kind: "file", bytes: 12, modified: 2 },
  { name: "quarterly-figures-2026.xlsx", kind: "file", bytes: 48_211, modified: 3 }];

function host(PIP, scene) {
  window.__scene = scene; window.__sent = []; window.__posted = [];
  const post = (m) => window.postMessage(m, "*");
  const answers = {
    get_pip_computer: () => ({ computer: { pip_id: PIP.id, granted: true, available: true, reason: "", pending: (scene.actions || []).length, actions: scene.actions || [] } }),
    // Its held submits (scene.actions): an answer settles one, and it is gone from the next look.
    decide_pip_computer_action: (r) => { const a = scene.actions.find((x) => x.id === r.action_id); scene.actions = scene.actions.filter((x) => x !== a); return { action: { ...a, status: r.approve ? "approved" : "rejected" } }; },
    // (scene.view: the picture of its browser, for a test that opens the Browser window.)
    use_pip_computer_view: () => ({ view: scene.view || { ok: false, error: "" } }),
    open_pip_computer: () => ({ view: { pip_id: PIP.id, ready: true } }),
    list_pip_computer_files: (r) => ({ path: r.path, entries: r.path ? [] : scene.files, more: false, total_bytes: scene.files.reduce((n, f) => n + (f.bytes || 0), 0) }),
    read_pip_computer_file: (r) => { const f = scene.files.find((x) => x.name === r.path) || { bytes: 12 }; const big = f.bytes > 2 * 1024 * 1024;
      return { path: r.path, name: r.path.split("/").at(-1), mime: big ? "application/octet-stream" : "text/plain", bytes: f.bytes, ...(big ? { too_large: true } : { text: "buy milk\n", truncated: false }) }; },
    add_pip_computer_file: (r) => { scene.files.push({ name: r.name, kind: "file", bytes: 3, modified: 9 }); return { path: r.name, name: r.name, bytes: 3 }; },
  };
  window.acquireVsCodeApi = () => ({ getState: () => window.__state, setState(s) { window.__state = s; }, postMessage(m) {
    if (m?.type === "pipsRequest") {
      window.__sent.push(m.request);
      const make = answers[m.request.type];
      setTimeout(() => post(make ? { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } : { type: "pipsReply", id: m.id, ok: false, error: "Not in this scene." }), 5);
      return;
    }
    window.__posted.push(m);
  } });
  window.__start = () => { post({ type: "pipComputerInit", pip: PIP, desktop: false });
    post({ type: "pipsConnection", generation: 7, apiVersion: scene.api, connected: true, supported: true, enabled: true }); };
}

/** Open the tab on its Files. `opts`: width, height, theme, api, files, actions (its held submits). Returns the page `p`; `say(message)`, the host
 *  speaking to the page; `scene(patch)`; `posted(type)`; `sent(type)`; `errors`; `close()`. */
export async function openFiles(browser, opts = {}) {
  const { width = 700, height = 640, theme = "dark", api = 87, files = FILES } = opts;
  const { js, css } = await bundle();
  const t = THEMES[theme];
  const page = `<!DOCTYPE html><html><head><meta charset="utf-8">${VSCODE_WEBVIEW}<style>${t.css}</style><style>${css}</style></head><body class="${t.kind}"><main id="app"></main>`
    + `<script>(${host})(${JSON.stringify(PIP)}, ${JSON.stringify({ api, files, actions: opts.actions || [] })});</script><script type="module" src="/ext/dist/pipComputer.js"></script></body></html>`;
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion: "reduce", colorScheme: theme });
  const p = await context.newPage();
  const errors = [];
  p.on("pageerror", (e) => errors.push(String(e)));
  p.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  await p.route("https://pc.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/ext/dist/pipComputer.js") return r.fulfill({ body: js, contentType: "text/javascript" });
    if (path === "/webview/index.html") return r.fulfill({ body: page, contentType: "text/html" });
    return r.fulfill({ status: 404, body: "" });
  });
  await p.goto("https://pc.test/webview/index.html", { waitUntil: "load" });
  await p.waitForFunction(() => window.__posted.some((m) => m.type === "pipsReady"));
  await p.evaluate(() => window.__start());
  await p.click("[data-app=files]");
  await p.waitForSelector(".pc-files .pc-name");
  return { p, errors,
    say: (message) => p.evaluate((m) => window.postMessage(m, "*"), message),
    scene: (patch) => p.evaluate((v) => Object.assign(window.__scene, v), patch),
    posted: (type) => p.evaluate((x) => window.__posted.filter((m) => m.type === x), type),
    sent: (type) => p.evaluate((x) => window.__sent.filter((r) => r.type === x), type),
    close: () => context.close() };
}
