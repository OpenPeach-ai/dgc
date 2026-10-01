// The jsdom harness every webview test shares: the exact HTML skeleton panel.ts ships, media/main.js
// evaluated against it, a scripted message channel, a manual clock, and the palette helpers.
// Not a *.test.mjs file, so `node --test "test/**/*.test.mjs"` never runs it on its own.
import { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM, VirtualConsole } from "jsdom";
import { buildSync } from "esbuild";

const dir = fileURLToPath(new URL("../", import.meta.url));
export const panelSrc = readFileSync(dir + "../src/panel.ts", "utf8");
export const mainJs = readFileSync(dir + "../media/main.js", "utf8");
export const markdownJs = buildSync({ entryPoints: [dir + "../src/markdown.ts"], bundle: true,
  format: "iife", globalName: "DgcMarkdown", platform: "browser", write: false }).outputFiles[0].text;
export const mainCss = readFileSync(dir + "../media/main.css", "utf8");

export function relativeLuminance(hex) {
  const channels = hex.match(/[0-9a-f]{2}/gi).map((part) => parseInt(part, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045
    ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

export function contrastRatio(foreground, background) {
  const light = Math.max(relativeLuminance(foreground), relativeLuminance(background));
  const dark = Math.min(relativeLuminance(foreground), relativeLuminance(background));
  return (light + 0.05) / (dark + 0.05);
}

export function rootHex(name) {
  const root = mainCss.match(/:root\s*\{([\s\S]*?)\}/)?.[1] || "";
  const value = root.match(new RegExp(`${name}\\s*:\\s*(#[0-9a-f]{6})`, "i"))?.[1];
  assert.ok(value, `missing hex palette token ${name}`);
  return value;
}

// Pull the real HTML template out of panel.ts's html() and neutralise the
// `${nonce}` / `${css}` / `${csp}` interpolations so the markup stays in sync
// with what ships — the test never hand-rolls its own DOM.
// panel.ts contains more than one document literal (the chat skeleton, and small notices such
// as the one shown in a view the conversation has left), so pick the chat by a landmark rather
// than by "the first doctype in the file".
const htmlCandidates = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0]);
const htmlMatch = htmlCandidates.find((candidate) => candidate.includes('id="input"'));
assert.ok(htmlMatch, "could not extract the webview HTML template from panel.ts");
export const html = htmlMatch.replace(/\$\{[^}]*\}/g, "");

export const activeDoms = new Set();
afterEach(() => { for (const dom of activeDoms) dom.window.close(); activeDoms.clear(); });

// A stand-in for layout, for tests of code that decides things from real geometry (the long-prompt
// fold). jsdom lays nothing out, so every size it reports is 0 -- which is why, without this option,
// no prompt ever folds and every other test sees today's DOM. With it, `#log` is `width` px wide, a
// `.prompt-text` wraps at `char` px a character (7.5: 40 to a line at 300px, 120 at 900px; a wider
// value stands in for new fonts) on `line` px lines and is clipped to five of them while its bubble
// is folded, and a `.msg` is 40px plus the visible height of the prompts inside it, so blocks settle,
// pin, and change height when they fold. The object is live: a test changes `layout.width` to stand
// in for a resize, and width 0 is a hidden panel (display: none), where nothing is laid out and every
// size is 0. Only a real browser can say what the CSS does with all this; prompt-fold-layout.test.mjs
// checks the real geometry.
function installLayout(window, layout) {
  const proto = window.HTMLElement.prototype;
  const isText = (node) => node.classList?.contains("prompt-text");
  const laidOut = (node) => node.isConnected && layout.width > 0;
  const natural = (node) => {
    const perLine = Math.max(1, Math.floor(layout.width / layout.char));
    const lines = String(node.textContent).split("\n").reduce((sum, row) => sum + Math.max(1, Math.ceil(row.length / perLine)), 0);
    return lines * layout.line;
  };
  const visible = (node) => (node.parentElement?.dataset.fold === "folded" ? Math.min(natural(node), 5 * layout.line) : natural(node));
  const getters = {
    clientWidth() {
      if (!laidOut(this)) return 0;
      return this.id === "log" ? layout.width : isText(this) ? Math.max(0, layout.width - 60) : 0;
    },
    scrollHeight() { return laidOut(this) && isText(this) ? natural(this) : 0; },
    clientHeight() { return laidOut(this) && isText(this) ? visible(this) : 0; },
    offsetHeight() {
      if (!laidOut(this) || !this.classList?.contains("msg")) return 0;
      return 40 + [...this.querySelectorAll(".prompt-text")].reduce((sum, text) => sum + visible(text), 0);
    },
  };
  for (const [name, get] of Object.entries(getters)) Object.defineProperty(proto, name, { configurable: true, get });
  const realStyle = window.getComputedStyle.bind(window);
  window.getComputedStyle = (node, pseudo) => {
    const style = realStyle(node, pseudo);
    if (pseudo || !isText(node)) return style;
    return new Proxy(style, { get: (target, key) => {
      if (key === "lineHeight") return `${layout.line}px`;
      const value = target[key];
      return typeof value === "function" ? value.bind(target) : value;
    } });
  };
}

// A ResizeObserver that never fires on its own: `resize(target)` delivers one entry for `target` to
// every observer watching it, in the order they were created, exactly when the test says so.
function installResizeObservers(window) {
  const observers = [];
  window.ResizeObserver = class {
    constructor(callback) { this.callback = callback; this.targets = new Set(); observers.push(this); }
    observe(target) { this.targets.add(target); }
    unobserve(target) { this.targets.delete(target); }
    disconnect() { this.targets.clear(); }
  };
  return (target) => {
    for (const observer of [...observers]) if (observer.targets.has(target)) observer.callback([{ target }], observer);
  };
}

// `options.script` replaces media/main.js (a test that instruments a hook stub evaluates its own copy).
// `options.layout` ({ width = 300, line = 21, char = 7.5 }) stands in for layout (installLayout), and
// `options.resizeObservers` installs observers the test fires with `resize(target)`. Both are opt-in,
// so every test that does not ask for them runs against plain jsdom, as it always has.
export function makeDom(options = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e));
  const markup = options.scope ? html.replace('data-draft-scope=""', `data-draft-scope="${options.scope}"`) : html;
  const dom = new JSDOM(markup, { runScripts: "outside-only", pretendToBeVisual: true, virtualConsole: vc });
  activeDoms.add(dom);
  const posted = [];
  let savedState = options.state;
  dom.window.TextEncoder = TextEncoder;
  dom.window.acquireVsCodeApi = () => ({
    postMessage: (m) => posted.push(m),
    getState: () => savedState,
    setState: (value) => { savedState = JSON.parse(JSON.stringify(value)); },
  });
  // A manual clock: timers only fire when the test advances time, so a timeout is asserted exactly.
  let now = 0, nextTimer = 1;
  const timers = new Map();
  if (options.clock) {
    Object.defineProperty(dom.window.performance, "now", { value: () => now });
    dom.window.setTimeout = (fn, ms = 0) => { const id = nextTimer++; timers.set(id, { at: now + Number(ms || 0), fn }); return id; };
    dom.window.clearTimeout = (id) => { timers.delete(id); };
  }
  const advance = (ms) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]); now = due[1].at; due[1].fn();
    }
    now = until;
  };
  const layout = options.layout ? { width: 300, line: 21, char: 7.5, ...options.layout } : null;
  if (layout) installLayout(dom.window, layout);
  const resize = options.resizeObservers ? installResizeObservers(dom.window)
    : () => { throw new Error("resize() needs makeDom({ resizeObservers: true })"); };
  dom.window.eval(markdownJs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
  dom.window.eval(options.script ?? mainJs); // runs the webview IIFE against this DOM
  const send = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
  return { dom, errors, posted, send, advance, layout, resize, doc: dom.window.document, savedState: () => savedState };
}
