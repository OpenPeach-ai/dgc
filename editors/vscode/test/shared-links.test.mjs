// One way of doing a link, for Work, ChatDGC and Pips (media/mentions.js): the rule for a pasted link, a sent prompt's
// links as the same `.md-link` buttons an answer's links are (as nodes, and as a string for a page that builds strings),
// and the one fallback that puts the bundled mark back when a favicon cannot load. The pages keep no copy of their own.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const root = new URL("..", import.meta.url).pathname;
const read = (name) => readFileSync(root + name, "utf8");
const markdown = buildSync({ entryPoints: [root + "src/markdown.ts"], bundle: true, format: "iife", globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;

function page({ favicons = "on" } = {}) {
  const dom = new JSDOM(`<!doctype html><body data-link-favicons="${favicons}"><div id="out"></div></body>`, { runScripts: "outside-only" });
  const w = dom.window;
  w.eval(markdown + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
  w.DgcMarkdown.setFavicons(favicons === "on");
  w.eval(read("media/mentions.js"));
  return { w, M: w.DgcMentions, doc: w.document, out: w.document.getElementById("out") };
}
const ICON = (origin) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(origin)}&sz=32`;

test("a paste that is exactly one http(s) link is a link; prose with a link in it is prose", () => {
  const { M } = page();
  assert.equal(typeof M.pastedLink, "function", "the rule lives in the shared box's module");
  assert.equal(M.pastedLink("https://vibedgc.com/pricing?ref=a#b"), "https://vibedgc.com/pricing?ref=a#b");
  assert.equal(M.pastedLink("  http://localhost:3000/x \n"), "http://localhost:3000/x", "the white space around it is not the link");
  for (const prose of ["see https://vibedgc.com", "https://a.example https://b.example", "https://a.example\nhttps://b.example", "ftp://files.example/a", "vibedgc.com", "https://", "", "   "])
    assert.equal(M.pastedLink(prose), "", JSON.stringify(prose));
});

test("a sent prompt's links are links: the same button an answer's link is, the words around them untouched", () => {
  const { M, doc } = page();
  const text = "Read https://vibedgc.com/pricing?ref=chat. Then (https://github.com/openai/codex) and <b>not markup</b>";
  const node = M.linkWords(text, { doc });
  assert.equal(node.className, "prompt-text");
  assert.equal(node.textContent, text, "the words are exactly what was sent");
  const links = [...node.querySelectorAll("button.md-link.prompt-link")];
  assert.deepEqual(links.map((a) => a.dataset.target), ["https://vibedgc.com/pricing?ref=chat", "https://github.com/openai/codex"], "the full stop and the bracket are not the link's");
  assert.ok(links.every((a) => a.type === "button" && a.dataset.linkKind === "external" && a.title === a.dataset.target));
  assert.equal(node.querySelector("b"), null, "typed markup stays text");
  // Its favicon: the origin only, the bundled mark kept as the fallback.
  const img = links[0].querySelector("img.link-favicon");
  assert.equal(img.getAttribute("src"), ICON("https://vibedgc.com"));
  assert.equal(img.getAttribute("referrerpolicy"), "no-referrer");
  assert.equal(links[0].dataset.linkFallback, "dgc");
  assert.equal(links[0].dataset.linkSource, undefined, "with a favicon the bundled mark does not also draw");
  assert.equal(links[1].dataset.linkFallback, "github");
});

test("the string form is the same links, for a page that builds strings", () => {
  const { M, doc, out } = page();
  const text = 'Look at https://vibedgc.com/docs and <img src=x onerror="alert(1)">';
  const html = M.linkWordsHtml(text, { doc });
  assert.equal(typeof html, "string");
  out.innerHTML = `<div class="prompt-text">${html}</div>`;
  assert.equal(out.textContent, text);
  assert.equal(out.querySelectorAll("img:not(.link-favicon)").length, 0, "what was typed is never markup");
  const link = out.querySelector("button.md-link.prompt-link");
  assert.equal(link.dataset.target, "https://vibedgc.com/docs");
  assert.equal(link.querySelector("img.link-favicon").getAttribute("src"), ICON("https://vibedgc.com"));
  assert.equal(M.linkWordsHtml("no link here", { doc }), "no link here");
});

test("with dgc.linkFavicons off a link is its bundled mark, and nothing is asked for", () => {
  const { M, doc } = page({ favicons: "off" });
  const node = M.linkWords("https://github.com/openai/codex", { doc });
  assert.equal(node.querySelector("img"), null);
  assert.equal(node.querySelector(".md-link").dataset.linkSource, "github");
  assert.equal(M.linkWordsHtml("https://vibedgc.com", { doc }).includes("<img"), false);
});

test("a favicon that cannot load gives the bundled mark back, in a page and in a shadow root, and is not asked for again", () => {
  const { M, doc, out, w } = page();
  const shadowHost = doc.createElement("section"); doc.body.append(shadowHost);
  const shadow = shadowHost.attachShadow({ mode: "open" });
  for (const where of [out, shadow]) {
    const stop = M.watchFavicons(where === out ? doc : shadow);
    assert.equal(typeof stop, "function");
    where.append(M.linkWords(where === out ? "https://a.example/x" : "https://b.example/y", { doc }));
    const link = where.querySelector(".md-link"), img = link.querySelector("img.link-favicon");
    img.dispatchEvent(new w.Event("error"));
    assert.equal(link.querySelector("img"), null, "the broken image goes");
    assert.equal(link.dataset.linkSource, "web", "the bundled mark is back");
    assert.equal(link.dataset.linkFallback, undefined);
  }
  // The same site again (a redraw, another message): the mark, with no second request.
  const again = M.linkWords("https://a.example/other", { doc }).querySelector(".md-link");
  assert.equal(again.querySelector("img"), null);
  assert.equal(again.dataset.linkSource, "web");
  // A page that redraws from strings settles what it is about to draw (an answer's links too).
  const next = doc.createElement("template");
  next.innerHTML = w.DgcMarkdown.render("[a](https://a.example/z) and [c](https://c.example/)");
  M.settleFavicons(next.content);
  const [a, c] = next.content.querySelectorAll(".md-link");
  assert.equal(a.querySelector("img"), null, "the failed site's icon is not put back");
  assert.equal(a.dataset.linkSource, "web");
  assert.ok(c.querySelector("img.link-favicon"), "another site's is");
  // Watching twice is watching once.
  M.watchFavicons(doc);
  out.replaceChildren(M.linkWords("https://d.example/", { doc }));
  out.querySelector("img").dispatchEvent(new w.Event("error"));
  assert.equal(out.querySelector(".md-link").dataset.linkSource, "web");
});

test("one module: Work and ChatDGC keep no link drawing or fallback of their own", () => {
  const main = read("media/main.js"), chat = read("media/chatdgc.js"), transcript = read("src/pipsTranscript.js"), client = read("src/pipsClient.js");
  assert.doesNotMatch(main, /function promptLink\(|function promptFavicon\(|const PROMPT_URL\b/, "Work draws a prompt's links with the shared module");
  assert.match(main, /M\.linkWords\(/);
  assert.match(main, /M\.pastedLink\(/, "Work's own paste asks the shared rule");
  for (const [name, source] of [["Work", main], ["ChatDGC", chat]]) {
    assert.doesNotMatch(source, /classList\?\.contains\("link-favicon"\)/, `${name} has no favicon fallback of its own`);
    assert.match(source, /\.watchFavicons\(document\)/, `${name} uses the shared fallback`);
  }
  assert.match(chat, /M\.linkWords\(/, "ChatDGC draws a prompt's links with the shared module");
  assert.match(transcript, /linkWordsHtml\(/, "a Pip's bubble draws them with the shared module");
  assert.match(client, /watchFavicons\(root\)/, "the Pips page uses the shared fallback, in the root it is drawn in");
  assert.match(client, /settleFavicons\(/);
  // The marks themselves: one style sheet, in Work's page (ChatDGC loads the same) and in the Pips bundle.
  const css = read("media/shared/links.css");
  assert.match(css, /\.md-link\[data-link-source="web"\]::before/);
  assert.match(css, /\.md-link \.link-favicon/);
  assert.match(read("media/main.css"), /@import url\("\.\/shared\/links\.css"\)/);
  assert.match(client, /import '\.\.\/media\/shared\/links\.css'/);
  assert.doesNotMatch(read("media/main.css"), /\.md-link\[data-link-source="web"\]::before/, "and not twice");
});
