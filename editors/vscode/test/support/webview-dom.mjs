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

// `options.script` replaces media/main.js (a test that instruments a hook stub evaluates its own copy).
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
  dom.window.eval(markdownJs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
  dom.window.eval(options.script ?? mainJs); // runs the webview IIFE against this DOM
  const send = (data) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data }));
  return { dom, errors, posted, send, advance, doc: dom.window.document, savedState: () => savedState };
}
