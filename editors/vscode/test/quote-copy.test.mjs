// A quoted block is usually the one part of an answer meant to leave the panel whole: a drafted
// mail, a message to forward. It was the last copyable block with no copy button, and it was the
// only one drawn without room at its top and bottom, so its first and last lines read as cut off.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { mainCss } from "./support/webview-dom.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const bundled = buildSync({ entryPoints: [here + "../src/markdown.ts"], bundle: true,
  format: "cjs", write: false, platform: "node" }).outputFiles[0].text;
const markdown = (() => {
  const module = { exports: {} };
  new Function("module", "exports", "require", bundled)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
})();
const { render } = markdown;

const copied = (html) => {
  const m = /<blockquote>.*?class="copy" data-c="([^"]*)"/s.exec(html);
  return m ? decodeURIComponent(m[1]) : null;
};

test("a quoted block carries a copy button", () => {
  const html = render("> Hello there,\n>\n> Please ship it.\n");
  assert.match(html, /<blockquote>\s*<button type="button" class="copy"/);
  assert.match(html, /aria-label="Copy quoted text"/);
});

test("what it copies is the text, not the quote markers", () => {
  // The reader wants the mail on the clipboard, not "> " running down its left edge.
  assert.equal(copied(render("> Hello there,\n>\n> Please ship it.\n")),
               "Hello there,\n\nPlease ship it.");
});

test("the markdown inside a quote survives the copy", () => {
  // A drafted mail is full of structure -- bold, bullets, inline code. Copying the rendered DOM
  // would flatten all of it; copying the source keeps it pasteable.
  const source = "> **Subject:** Enrich API\n>\n> - `06AAACP0227H1ZW` — Bawal\n> - `07AAACP0227H1ZU` — Delhi\n";
  assert.equal(copied(render(source)),
               "**Subject:** Enrich API\n\n- `06AAACP0227H1ZW` — Bawal\n- `07AAACP0227H1ZU` — Delhi");
});

test("a nested quote does not get a second button", () => {
  // The inner quote is part of what the outer button already copies.
  const html = render("> outer\n>\n> > inner\n");
  assert.equal((html.match(/class="copy"/g) || []).length, 1);
});

test("a quote next to other blocks copies only itself", () => {
  const html = render("Before.\n\n> the mail\n\nAfter.\n");
  assert.equal(copied(html), "the mail");
});

test("a quote is drawn with room at its top and bottom", () => {
  // The bug: `padding-left` alone meant the first line sat on the block's top edge and the last
  // ran off its bottom, which reads as text that has been cut rather than text in a block.
  const css = mainCss;
  const rule = /\.text blockquote, \.surface-markdown blockquote \{([^}]*)\}/.exec(css);
  assert.ok(rule, "the blockquote rule is still there to check");
  const body = rule[1];
  assert.match(body, /padding:\s*var\(--sp-3\)\s+var\(--sp-4\)/, "padding on all four sides");
  assert.doesNotMatch(body, /padding-left\s*:/, "no side-only padding left behind");
  // Without this the first heading's own top margin doubles the gap it was just given. The copy
  // button is the blockquote's own first child, so the rule has to reach the child AFTER it too --
  // otherwise it lands on the button, which is absolutely positioned and does not care.
  assert.match(css, /blockquote > :first-child[^{]*\{[^}]*margin-top: 0/);
  assert.match(css, /blockquote > \.copy \+ \*[^{]*\{[^}]*margin-top: 0/);
  assert.match(css, /blockquote > :last-child[^{]*\{[^}]*margin-bottom: 0/);
});

test("the quote's copy button is positioned like every other one", () => {
  // A table's button once shipped with no position rule and rendered as a word floating above the
  // table. The quote joins the existing selector list so it cannot drift from the others.
  const css = mainCss;
  assert.match(css, /blockquote > \.copy \{[^}]*position: absolute/);
  assert.match(css, /blockquote:hover > \.copy \{[^}]*opacity: 1/);
  assert.match(css, /blockquote > \.copy:focus-visible \{[^}]*opacity: 1/);
});

test("the quote's copy button is the same size as every other one", () => {
  // The button IS the blockquote's first child, so the "room for the button" padding rule matched
  // the button itself: 38px wide against the 20px of a code fence's and a table's, with its icon
  // pushed outside its own content box. Measured in Chromium: blockquote 38x20 / pr 36px, fence
  // and table 20x20 / pr 0. The :not(.copy) is what keeps them identical.
  const css = mainCss;
  const rule = /\.text blockquote > :first-child(:not\(\.copy\))?/.exec(css);
  assert.ok(rule, "the first-child rule is still there to check");
  assert.equal(rule[1], ":not(.copy)",
               "without :not(.copy) the padding lands on the button and widens it");
});
