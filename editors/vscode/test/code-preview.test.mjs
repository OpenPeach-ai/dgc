// A preview of the HTML or SVG a reply writes (0.52): one line of link text under the code block, "Preview: <title>",
// styled as a session's image link is (an .md-link), that opens the rendered page in an editor tab beside. Not a card,
// nothing rendered in the chat. A CSS block in the same reply goes with that reply's HTML; CSS alone gets no line. The
// line comes from the reply's own text, so a reload draws it again. Only DGC's own reply in a chat gets one: a skill's
// page, the docs and a report keep the code as code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import { makeDom, markdownJs } from "./support/webview-dom.mjs";

const dir = fileURLToPath(new URL("../", import.meta.url));
const read = (name) => readFileSync(dir + name, "utf8");

function md() {
  const dom = new JSDOM("<!doctype html><body><div id=reply></div></body>", { runScripts: "outside-only" });
  dom.window.eval(markdownJs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
  const M = dom.window.DgcMarkdown, box = dom.window.document.getElementById("reply");
  const draw = (text, options = { cards: true, previews: true }) => { box.innerHTML = M.render(text, options); return [...box.querySelectorAll(".code-preview")]; };
  return { M, box, draw, doc: dom.window.document };
}
// What the page made, as plain data: an object from the page's own realm never deep-equals one made here.
const plain = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
const fence = (lang, body) => "```" + lang + "\n" + body + "\n```";
const ICONS_HTML = '<!doctype html>\n<html>\n<head>\n<title>Cube icons</title>\n</head>\n<body>\n<h1>The set</h1>\n<ul class="grid"><li class="cube red">Red</li></ul>\n</body>\n</html>';
const ICONS_CSS = ".grid { display: grid; gap: 8px; }\n.cube.red { background: #e5484d; }";

test("an HTML block in a reply gets one line of link text under it, an SVG block too; other code gets none", () => {
  const x = md();
  let links = x.draw(`Here is the page:\n\n${fence("html", ICONS_HTML)}\n\nAnd a mark:\n\n${fence("svg", '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><title>Dot</title><circle cx="4" cy="4" r="3"/></svg>')}\n\n${fence("python", "print('<html>')")}`);
  assert.deepEqual(links.map((l) => l.textContent), ["Preview: Cube icons", "Preview: Dot"]);
  for (const link of links) {
    assert.equal(link.tagName, "BUTTON", "the keyboard reaches it, and Enter presses it");
    assert.equal(link.getAttribute("type"), "button");
    assert.ok(link.classList.contains("md-link"), "the sessions' link style, as an image's link has");
    assert.equal(link.dataset.linkKind, "preview");
    assert.equal(link.dataset.target, undefined, "it points at nothing outside the reply");
    const line = link.parentElement;
    assert.equal(line.className, "code-preview-line");
    assert.deepEqual([...line.children], [link], "one line of text: no card, no box, no thumbnail");
    assert.equal(line.previousElementSibling.matches("pre.code"), true, "right under its code block");
    assert.equal(x.box.querySelectorAll("iframe, img, svg, .card").length, 0, "nothing renders in the chat");
  }
  assert.deepEqual(links.map((l) => l.dataset.fileKind), ["markup", "svg"], "each wears its file kind's mark, as a link to a file does");
  // Written as models write them.
  for (const [lang, body, said] of [["HTML", "<h2>Hello</h2>", "Preview: Hello"], ["htm", "<p>Hi</p>", "Preview: the HTML"], ["xml", '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>', "Preview: the SVG"],
    ["html title=demo.html", "<title> A   &amp; B </title>", "Preview: A & B"]]) {
    assert.deepEqual(x.draw(fence(lang, body)).map((l) => l.textContent), [said], lang);
  }
  for (const [lang, body] of [["css", ICONS_CSS], ["xml", "<note><to>Sam</to></note>"], ["js", "document.title"], ["", "<html></html>"], ["html", "   \n"], ["jsx", "<div/>"]]) {
    assert.deepEqual(x.draw(fence(lang, body)), [], `no line for ${lang || "a block with no language"}`);
  }
});

test("its title: the page's <title>, else its first heading, else plain words; never markup", () => {
  const { M } = md();
  assert.equal(M.previewTitle("html", "<html><head><title>Icon set</title></head><body><h1>Other</h1></body></html>"), "Icon set");
  assert.equal(M.previewTitle("html", "<main><h2 class='x'>Cube <em>icons</em></h2><h1>Later</h1></main>"), "Cube icons");
  assert.equal(M.previewTitle("html", "<div class=grid></div>"), "the HTML");
  assert.equal(M.previewTitle("html", "<title>  </title><p>x</p>"), "the HTML", "an empty title is no title");
  assert.equal(M.previewTitle("svg", "<svg><circle/></svg>"), "the SVG");
  assert.equal(M.previewTitle("svg", "<svg><title>Logo mark</title></svg>"), "Logo mark");
  assert.equal(M.previewTitle("html", "<title>a &lt;b&gt; &quot;c&quot; &#39;d&#39; &amp;amp;</title>"), "a <b> \"c\" 'd' &amp;");
  assert.equal(M.previewTitle("html", `<title>${"long ".repeat(60)}</title>`).length <= 80, true, "a long one is cut");
  const x = md();
  const [link] = x.draw(fence("html", "<title><img src=x onerror=alert(1)>&lt;script&gt;</title>"));
  assert.equal(link.children.length, 0, "the title is text in the line");
  assert.equal(link.textContent, "Preview: <script>");
});

test("a CSS block in the same reply goes with that reply's HTML; a reply with only CSS gets no line", () => {
  const x = md();
  const [link] = x.draw(`The demo:\n\n${fence("html", ICONS_HTML)}\n\nUpdated CSS:\n\n${fence("css", ICONS_CSS)}\n\n- and in a list:\n\n  ${fence("CSS", ".late { color: red; }").replace(/\n/g, "\n  ")}\n`);
  const view = plain(x.M.previewOf(link));
  assert.equal(view.kind, "html");
  assert.equal(view.title, "Cube icons");
  assert.equal(view.html, ICONS_HTML + "\n", "the page exactly as the reply wrote it");
  assert.deepEqual(view.css, [ICONS_CSS + "\n", ".late { color: red; }\n"], "every CSS block of the reply, in order");
  assert.deepEqual(x.draw(`Only the stylesheet:\n\n${fence("css", ICONS_CSS)}`), []);
  // An SVG is a picture by itself: the reply's CSS is for its HTML.
  const [mark] = x.draw(`${fence("svg", "<svg><title>Dot</title></svg>")}\n\n${fence("css", ICONS_CSS)}`);
  assert.deepEqual(plain(x.M.previewOf(mark)), { kind: "svg", title: "Dot", html: "<svg><title>Dot</title></svg>\n", css: [] });
  // Two pages in one reply: each line opens its own block.
  const two = x.draw(`${fence("html", "<title>One</title>")}\n\n${fence("html", "<title>Two</title>")}`);
  assert.deepEqual(two.map((l) => x.M.previewOf(l).html), ["<title>One</title>\n", "<title>Two</title>\n"]);
  // In a list or a quote the line still finds its block and the reply's CSS.
  const [nested] = x.draw(`1. First:\n\n   ${fence("html", "<h1>In a list</h1>").replace(/\n/g, "\n   ")}\n\n${fence("css", "h1 { color: teal; }")}`);
  assert.deepEqual(plain(x.M.previewOf(nested)), { kind: "html", title: "In a list", html: "<h1>In a list</h1>\n", css: ["h1 { color: teal; }\n"] });
  assert.equal(x.M.previewOf(x.doc.createElement("button")), undefined, "a button that is no preview line opens nothing");
});

test("a block still being written has no line yet, and only a reply in a chat gets one", () => {
  const x = md();
  assert.deepEqual(x.draw("Writing it:\n\n```html\n<title>Half"), [], "the fence isn't closed: the page isn't whole");
  assert.deepEqual(x.draw("Writing it:\n\n```html\n<title>Half</title>\n```").map((l) => l.textContent), ["Preview: Half"]);
  assert.deepEqual(x.draw("> ```html\n> <h1>Quoted</h1>\n> ```").map((l) => l.textContent), ["Preview: Quoted"]);
  assert.deepEqual(x.draw(fence("html", ICONS_HTML), {}), [], "a skill's page, the docs, a report: code stays code");
  assert.deepEqual(x.draw(fence("html", ICONS_HTML), { cards: true }), [], "asked for by name, never by the cards");
  assert.equal(x.M.render(fence("html", ICONS_HTML)), x.M.render(fence("html", ICONS_HTML), { previews: false }));
});

test("Work: a reply's HTML block gets the line as it streams in and again after a reload; a click posts the page and its CSS", () => {
  const x = makeDom();
  const event = (ev) => x.send({ type: "event", event: ev });
  event({ type: "ready", capabilities: {} });
  event({ type: "turn_start", turn_id: "t1", prompt: "An icon set" });
  event({ type: "text_delta", text: `Here it is:\n\n${fence("html", ICONS_HTML)}\n\nUpdated CSS:\n\n${fence("css", ICONS_CSS)}\n` });
  event({ type: "stream_end", message_id: "t1:1", phase: "final_answer" });
  event({ type: "turn_end", turn_id: "t1", status: "completed" });
  const links = () => [...x.doc.querySelectorAll("#log .code-preview")];
  assert.deepEqual(links().map((l) => l.textContent), ["Preview: Cube icons"]);
  links()[0].click();
  assert.deepEqual(plain(x.posted.filter((m) => m.type === "codePreview")),
    [{ type: "codePreview", kind: "html", title: "Cube icons", html: ICONS_HTML + "\n", css: [ICONS_CSS + "\n"] }]);
  assert.equal(x.posted.some((m) => m.type === "openFile" || m.type === "openExternal"), false, "it opens no file and no site");
  // After a reload the transcript comes back from the saved text: the line is there again.
  const y = makeDom();
  y.send({ type: "event", event: { type: "ready", capabilities: {} } });
  y.send({ type: "event", event: { type: "session", kind: "resumed", session_id: "s1", message_count: 2 } });
  y.send({ type: "event", event: { type: "history", items: [{ role: "user", text: "An icon set" },
    { role: "assistant", text: `Here it is:\n\n${fence("html", ICONS_HTML)}\n\n${fence("css", ICONS_CSS)}` }] } });
  const again = [...y.doc.querySelectorAll("#log .code-preview")];
  assert.deepEqual(again.map((l) => l.textContent), ["Preview: Cube icons"]);
  again[0].click();
  assert.deepEqual(plain(y.posted.filter((m) => m.type === "codePreview").map((m) => [m.html, m.css])), [[ICONS_HTML + "\n", [ICONS_CSS + "\n"]]]);
  // What you typed is never given one.
  assert.equal(y.doc.querySelectorAll("#log .msg.user .code-preview").length, 0);
  assert.deepEqual([...x.errors, ...y.errors], []);
});

test("ChatDGC and a Pip's chat ask for the line in their replies, post the same message, and leave it out of a copied reply", () => {
  const chat = read("media/chatdgc.js"), pips = read("src/pipsClient.js"), work = read("media/main.js");
  assert.match(chat, /render\(String\(text \|\| ""\), \{ cards, previews: cards \}\)/, "ChatDGC: where a card may be drawn, a preview line may");
  assert.match(pips, /function renderPipReply\(text\)\{[^}]*previews:true/, "a Pip's reply");
  assert.doesNotMatch(pips.match(/function renderPipMarkdown\(text\)\{[^\n]*/)[0], /previews/, "a Pip's report and its fixes keep code as code");
  assert.match(work, /const mdReply = \(source\) => DgcMarkdown\.render\(source, \{ cards: true, previews: true \}\)/);
  assert.match(work, /const md = \(source\) => DgcMarkdown\.render\(source\);/, "Work's other pages keep code as code");
  for (const [name, source] of [["media/main.js", work], ["media/chatdgc.js", chat], ["src/pipsClient.js", pips]]) {
    assert.match(source, /type:\s*['"]codePreview['"]/, `${name} posts codePreview`);
    assert.match(source, /previewOf/, `${name} reads the page from the reply's own blocks`);
  }
  assert.match(chat, /\.code-preview-line/, "ChatDGC's copy of a reply drops the line (it is the screen's, not the reply's)");
  for (const host of ["src/panel.ts", "src/chatdgc.ts", "src/pipsView.ts"]) {
    assert.match(read(host), /codePreview/, `${host} opens the tab`);
  }
});

test("no new field anywhere: the protocol and the saved chat are as they were", () => {
  assert.doesNotMatch(read("src/protocol.generated.ts"), /code_?preview/i);
});
