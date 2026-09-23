// A URL you type in a prompt is a link, and it wears the site's own favicon.
//
// Codex does this by handing the ORIGIN to Google's favicon service and widening its webview CSP
// to img-src https:. We copy that mechanism exactly. What these tests hold still are the three
// things that make copying it safe rather than merely similar:
//
//   1. Only the origin is ever sent. A pasted URL with a token in its path or query discloses its
//      host and nothing else -- the difference between "google sees you visited a jira" and
//      "google sees your jira ticket id and session token".
//   2. The bubble is still built from DOM nodes, not an HTML string. This is verbatim user input;
//      an escaping mistake here is an injection, not a cosmetic bug.
//   3. textContent is unchanged, because bubbleProse() compares it to decide whether a prompt has
//      already been echoed. Linkifying must not make every prompt render twice.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { buildSync } from "esbuild";
import { fileURLToPath } from "node:url";
import { makeDom } from "./support/webview-dom.mjs";

const here = fileURLToPath(new URL(".", import.meta.url));
const bundled = buildSync({ entryPoints: [here + "../src/markdown.ts"], bundle: true,
  format: "cjs", write: false, platform: "node" }).outputFiles[0].text;
const markdown = (() => {
  const module = { exports: {} };
  new Function("module", "exports", "require", bundled)(module, module.exports, createRequire(import.meta.url));
  return module.exports;
})();
const { faviconUrl } = markdown;

// ---- the icon URL itself -------------------------------------------------------------

test("only the origin is sent to the icon service", () => {
  const url = faviconUrl("https://jira.internal.corp/browse/SEC-1?token=s3cr3t#comment-9");
  assert.ok(url, "an https link should resolve an icon");
  assert.match(url, /domain=https%3A%2F%2Fjira\.internal\.corp&/);
  for (const secret of ["SEC-1", "browse", "token", "s3cr3t", "comment-9"]) {
    assert.equal(url.includes(secret), false,
      `the icon request must not carry ${secret}: the path and query never leave the machine`);
  }
});

test("it is Codex's service, keyed the way Codex keys it", () => {
  assert.equal(faviconUrl("https://vibedgc.com/docs"),
    "https://www.google.com/s2/favicons?domain=https%3A%2F%2Fvibedgc.com&sz=32");
});

test("a port is part of the origin, so a dev server gets its own icon", () => {
  assert.match(faviconUrl("http://localhost:3000/app"), /localhost%3A3000/);
});

test("only http and https resolve an icon", () => {
  for (const hostile of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>",
                         "vscode://x", "not a url at all", ""]) {
    assert.equal(faviconUrl(hostile), undefined, `${hostile} must not become an icon request`);
  }
});

// ---- the bubble ----------------------------------------------------------------------

// Driven through the real composer, the way every other webview test drives it, so this covers
// the path a person actually takes rather than a renderer called directly.
function bubbleFor(harness, text) {
  const { doc } = harness;
  doc.getElementById("input").value = text;
  doc.getElementById("send").click();
  return [...doc.querySelectorAll(".msg.user .bubble")].at(-1);
}

test("a typed URL becomes the same kind of link an answer's URLs are", () => {
  const dom = makeDom();
  const bubble = bubbleFor(dom, "look at https://vibedgc.com/docs please");
  const link = bubble.querySelector("button.md-link.prompt-link");
  assert.ok(link, "the URL should be a link button");
  assert.equal(link.dataset.linkKind, "external");
  assert.equal(link.dataset.target, "https://vibedgc.com/docs");
  assert.equal(link.textContent, "https://vibedgc.com/docs");
});

test("the prose around it is untouched and still reads as one string", () => {
  const dom = makeDom();
  const text = "look at https://vibedgc.com/docs please";
  const bubble = bubbleFor(dom, text);
  assert.equal(bubble.querySelector(".prompt-text").textContent, text,
    "textContent is what bubbleProse compares; changing it would echo every prompt twice");
});

test("a prompt with no URL is untouched", () => {
  const dom = makeDom();
  const bubble = bubbleFor(dom, "explain this function");
  assert.equal(bubble.querySelector(".prompt-text").textContent, "explain this function");
  assert.equal(bubble.querySelector("button.md-link"), null);
});

test("markup in a prompt is still inert", () => {
  const dom = makeDom();
  const nasty = `<img src=x onerror="alert(1)"> and <script>alert(2)</script> https://x.dev`;
  const bubble = bubbleFor(dom, nasty);
  const body = bubble.querySelector(".prompt-text");
  assert.equal(body.querySelector("script"), null, "a typed <script> must never become an element");
  assert.equal(body.querySelectorAll("img[src='x']").length, 0,
    "a typed <img> must never become an element, least of all one that loads");
  assert.ok(body.textContent.includes("<script>alert(2)</script>"),
    "it should read back exactly as typed");
});

test("a sentence's punctuation is not swallowed into the link", () => {
  const dom = makeDom();
  const text = "see https://vibedgc.com. also (https://x.dev) ok";
  const bubble = bubbleFor(dom, text);
  // What the reader sees is the test: the full stop and the bracket stay outside the underline.
  // data-target is the normalised href (new URL(...).href), which gains a trailing slash on a
  // bare origin -- that is the destination, not the label, and normalising it is correct.
  const labels = [...bubble.querySelectorAll("button.md-link")].map((n) => n.textContent);
  assert.deepEqual(labels, ["https://vibedgc.com", "https://x.dev"]);
  assert.equal(bubble.querySelector(".prompt-text").textContent, text,
    "and the punctuation is still there, outside the links");
});

// ---- the favicon ---------------------------------------------------------------------

test("the link carries the site's own favicon", () => {
  const dom = makeDom();
  const bubble = bubbleFor(dom, "https://vibedgc.com/docs");
  const img = bubble.querySelector("button.md-link .link-favicon");
  assert.ok(img, "a typed link should show a favicon");
  assert.match(img.getAttribute("src"), /^https:\/\/www\.google\.com\/s2\/favicons\?domain=/);
  assert.equal(img.getAttribute("aria-hidden"), "true", "it is decoration beside a readable URL");
  assert.equal(img.getAttribute("alt"), "");
});

test("with the setting off, nothing is requested and the bundled mark shows instead", () => {
  const dom = makeDom();
  dom.doc.body.dataset.linkFavicons = "off";
  const bubble = bubbleFor(dom, "https://github.com/x/y");
  const link = bubble.querySelector("button.md-link");
  assert.equal(link.querySelector(".link-favicon"), null,
    "turning it off must mean no request at all, not a hidden one");
  assert.equal(link.dataset.linkSource, "github", "and the bundled glyph takes over");
});

test("an icon that fails to load falls back to the bundled mark", () => {
  const dom = makeDom();
  const bubble = bubbleFor(dom, "https://github.com/x/y");
  const link = bubble.querySelector("button.md-link");
  const img = link.querySelector(".link-favicon");
  assert.ok(img);
  assert.equal(link.dataset.linkFallback, "github", "the mark waits as a fallback, undrawn");
  assert.equal(link.dataset.linkSource, undefined, "or the glyph and the favicon would both show");
  // A real event, not a hand-called onerror: the handler is one listener at the document, in the
  // capture phase, because `error` does not bubble and the markdown path builds an HTML string
  // it cannot attach a closure to.
  img.dispatchEvent(new dom.dom.window.Event("error"));
  assert.equal(link.querySelector(".link-favicon"), null);
  assert.equal(link.dataset.linkSource, "github",
    "a blank gap where a link's mark should be is worse than no favicon");
});

test("a link in the MODEL's answer wears the favicon too", () => {
  // The line DGC used to draw and Codex does not. The founder asked for Codex's behaviour.
  const dom = makeDom();
  // Backend events reach the panel wrapped, the way panel.ts forwards them.
  const event = (data) => dom.send({ type: "event", event: data });
  event({ type: "turn_start", prompt: "docs?" });
  event({ type: "text_delta", text: "see [the docs](https://vibedgc.com/docs) for more" });
  event({ type: "turn_end", reason: "completed" });      // flushes the buffered markdown
  const link = dom.doc.querySelector(".text button.md-link");
  assert.ok(link, "a link in an answer should render");
  const img = link.querySelector("img.link-favicon");
  assert.ok(img, "and carry the site's favicon, not only a bundled glyph");
  assert.match(img.getAttribute("src"), /^https:\/\/www\.google\.com\/s2\/favicons\?domain=/);
  assert.equal(img.getAttribute("src").includes("/docs"), false,
    "the path of a link in an answer must not leave the machine either");
  assert.equal(link.dataset.linkSource, undefined,
    "a link showing a favicon must not ALSO draw the bundled ::before glyph");
  assert.equal(link.dataset.linkFallback, "dgc", "the glyph waits as a fallback instead");
});
