// The preview tab's host side (src/codePreview.ts), bundled against a stub `vscode`: a reply's HTML or SVG opens in an
// editor tab beside, titled "Preview · <title>"; the same block again shows that tab; the tab runs no scripts and
// reaches nothing (its Content-Security-Policy has no script-src, the webview has scripts off and no local files);
// the reply's CSS is in the page; a page over 512 KB says "Too large to preview" instead.
import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { JSDOM } from "jsdom";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const world = { panels: [] };
globalThis.__DGC_PREVIEW_VSCODE = {
  ViewColumn: { Active: -1, Beside: -2 },
  window: {
    createWebviewPanel: (viewType, title, showOptions, options) => {
      const panel = { viewType, title, showOptions, options, disposed: false, revealed: [],
        webview: { html: "", cspSource: "vscode-resource:", onDidReceiveMessage: () => { throw new Error("the tab listens to nothing"); } },
        onDidDispose: (fn) => { panel.onDispose = fn; return { dispose() {} }; },
        reveal(...args) { panel.revealed.push(args); },
        dispose() { panel.disposed = true; panel.onDispose?.(); } };
      world.panels.push(panel);
      return panel;
    },
  },
};
const out = mkdtempSync(join(tmpdir(), "dgc-code-preview-build-"));
let preview;
try {
  const code = buildSync({ entryPoints: [join(root, "src/codePreview.ts")], bundle: true, format: "cjs", platform: "node",
    target: "node18", write: false, external: ["vscode"], logLevel: "silent" }).outputFiles[0].text
    .replace(/require\("vscode"\)/g, "(globalThis.__DGC_PREVIEW_VSCODE || {})");
  writeFileSync(join(out, "codePreview.cjs"), code);
  preview = createRequire(import.meta.url)(join(out, "codePreview.cjs"));
} finally {
  rmSync(out, { recursive: true, force: true });
}
beforeEach(() => { for (const p of [...world.panels]) if (!p.disposed) p.dispose(); world.panels = []; });

const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
const PAGE = '<!doctype html>\n<html>\n<head>\n<title>Cube icons</title>\n</head>\n<body>\n<ul class="grid"><li class="cube">Red</li></ul>\n</body>\n</html>\n';
const SHEET = ".grid { display: grid; }\n";
const ask = (more = {}) => ({ type: "codePreview", kind: "html", title: "Cube icons", html: PAGE, css: [SHEET], ...more });
const parsed = (html) => new JSDOM(html).window.document;
/** The pages the tab holds, one for each ground, as their frames would load them. */
const pages = (panel) => [...parsed(panel.webview.html).querySelectorAll("iframe")].map((f) => ({ frame: f, doc: parsed(f.getAttribute("srcdoc")), source: f.getAttribute("srcdoc") }));

test("a click opens an editor tab beside, titled Preview · <title>, with no scripts, no local files and no forms", () => {
  assert.equal(preview.openCodePreview(ask()), true);
  assert.equal(world.panels.length, 1);
  const [panel] = world.panels;
  assert.equal(panel.title, "Preview · Cube icons");
  assert.equal(panel.viewType, "dgc.codePreview");
  assert.equal(panel.showOptions.viewColumn ?? panel.showOptions, -2, "beside, as a widget and a canvas open");
  assert.equal(panel.options.enableScripts, false);
  assert.deepEqual(panel.options.localResourceRoots, []);
  assert.equal(panel.options.enableForms, false);
  assert.notEqual(panel.options.enableCommandUris, true);
  assert.notEqual(panel.options.retainContextWhenHidden, true);
});

test("the tab's Content-Security-Policy has no script-src, and nothing in the tab's own page is a script or a request", () => {
  preview.openCodePreview(ask());
  const html = world.panels[0].webview.html, doc = parsed(html);
  const metas = [...doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]')];
  assert.equal(metas.length, 1);
  assert.equal(metas[0].getAttribute("content"), CSP);
  assert.equal(preview.PREVIEW_CSP, CSP);
  assert.doesNotMatch(CSP, /script-src|connect-src|frame-src|https?:|\*/);
  assert.equal(doc.head.firstElementChild.getAttribute("charset"), "utf-8");
  assert.equal(doc.head.children[1], metas[0], "the policy comes before anything it governs");
  assert.equal(doc.querySelectorAll("script, link, object, embed, form, a[href], img").length, 0);
  assert.doesNotMatch(html.replace(/srcdoc="[^"]*"/g, ""), /https?:\/\/|\son[a-z]+=/i, "the tab's own page names no site and has no handlers");
  // The page as written is in frames that can run nothing, send nothing and open nothing.
  const frames = pages(world.panels[0]);
  assert.equal(frames.length, 2, "one for each ground");
  for (const { frame } of frames) {
    assert.equal(frame.getAttribute("sandbox"), "", "an empty sandbox: no scripts, no forms, no popups, no navigation out");
    assert.equal(frame.hasAttribute("src"), false);
    assert.equal(frame.getAttribute("title"), "Preview of Cube icons");
  }
});

test("the page is the reply's HTML as written with its CSS joined, on a light and a dark ground with a switch in the corner", () => {
  preview.openCodePreview(ask());
  const doc = parsed(world.panels[0].webview.html);
  const [light, dark] = pages(world.panels[0]);
  for (const page of [light, dark]) {
    assert.equal(page.doc.title, "Cube icons");
    assert.equal(page.doc.querySelector("ul.grid li.cube").textContent, "Red", "the page as written");
    assert.match(page.source, /^<!doctype html>/i, "its doctype still comes first");
    const sheets = [...page.doc.querySelectorAll("style")].map((s) => s.textContent);
    assert.equal(sheets.at(-1), SHEET, "the reply's stylesheet, after the page's own head");
    assert.equal(page.doc.querySelector("style:last-of-type").parentElement.tagName, "HEAD");
  }
  assert.match(light.doc.querySelector("style").textContent, /color-scheme:\s*light/);
  assert.match(dark.doc.querySelector("style").textContent, /color-scheme:\s*dark/);
  assert.equal(light.source.replace(/color-scheme:\s*light[^<]*/, ""), dark.source.replace(/color-scheme:\s*dark[^<]*/, ""), "the two differ only in their ground");
  // The switch: two choices a keyboard reaches, no script behind them.
  const choices = [...doc.querySelectorAll('input[type="radio"][name="ground"]')];
  assert.deepEqual(choices.map((c) => doc.querySelector(`label[for="${c.id}"]`).textContent.trim()), ["Light", "Dark"]);
  assert.equal(choices.some((c) => c.checked), false, "until you choose, the ground follows the editor's theme");
  assert.equal(doc.querySelector('[role="group"]').getAttribute("aria-label"), "Ground");
});

test("the page is made inert: links and forms go nowhere, a refresh or a base is taken out, markup in the CSS stays CSS", () => {
  const hostile = '<html><head><base href="https://evil.example/"><meta http-equiv="refresh" content="0;url=https://evil.example/">'
    + '<title>T</title></head><body><a href="https://evil.example/x" target="_blank">out</a><a href="#top">in</a>'
    + '<A HREF=https://evil.example/y>bare</A><map><area href="https://evil.example/z"></map>'
    + '<svg><a xlink:href="https://evil.example/s" href="https://evil.example/t"><text>s</text></a></svg>'
    + '<form action="https://evil.example/f"><button>Send</button></form><script>document.title="ran"</script></body></html>';
  preview.openCodePreview(ask({ html: hostile, css: ["</style><script>document.title='css'</script><style>"] }));
  for (const page of pages(world.panels[0])) {
    assert.deepEqual([...page.doc.querySelectorAll("base")].map((b) => b.getAttribute("href")), ["about:srcdoc"],
      "the page's own base is gone; the one base is the frame's own address, so a link within the page stays in it");
    assert.equal(page.doc.querySelector('meta[http-equiv="refresh" i]'), null);
    assert.deepEqual([...page.doc.querySelectorAll("a, area")].map((a) => a.getAttribute("href") ?? a.getAttribute("HREF")), ["#", "#top", "#", "#", "#"],
      "a link to elsewhere points nowhere; a link within the page still works");
    assert.equal(page.doc.querySelector("svg a").getAttribute("xlink:href"), "#");
    assert.doesNotMatch(page.source, /evil\.example\/[xyzst]\b/);
    assert.equal(page.doc.querySelectorAll("script").length, 1, "the page's own script is still there as written (it never runs); the CSS added none");
    assert.match([...page.doc.querySelectorAll("style")].at(-1).textContent, /script/, "markup in the CSS is CSS text");
  }
});

test("a fragment gets a standards-mode page around it; an SVG is drawn centred, without the reply's CSS", () => {
  preview.openCodePreview(ask({ html: '<div class="grid"><b>Hi</b></div>\n', title: "the HTML" }));
  const [fragment] = pages(world.panels[0]);
  assert.match(fragment.source, /^<!doctype html>/i);
  assert.equal(fragment.doc.querySelector("meta[charset]").getAttribute("charset"), "utf-8");
  assert.equal(fragment.doc.body.querySelector("div.grid b").textContent, "Hi");
  assert.equal([...fragment.doc.querySelectorAll("style")].at(-1).textContent, SHEET);
  assert.equal(world.panels[0].title, "Preview · the HTML");
  preview.openCodePreview({ type: "codePreview", kind: "svg", title: "Dot", html: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3"/></svg>', css: [SHEET] });
  const [svg] = pages(world.panels[1]);
  assert.equal(svg.doc.body.querySelectorAll("svg circle").length, 1);
  assert.equal(svg.source.includes(".grid"), false, "a reply's CSS is for its HTML");
});

test("opening the same block again shows its tab; a different block gets its own; a closed tab opens anew", () => {
  preview.openCodePreview(ask());
  preview.openCodePreview(ask());
  assert.equal(world.panels.length, 1);
  assert.equal(world.panels[0].revealed.length, 1, "the tab is shown again");
  preview.openCodePreview(ask({ css: [] }));
  preview.openCodePreview(ask({ html: PAGE.replace("Red", "Blue") }));
  assert.equal(world.panels.length, 3, "another page, or the same page with other CSS, is another tab");
  world.panels[0].dispose();
  preview.openCodePreview(ask());
  assert.equal(world.panels.length, 4);
  assert.equal(world.panels[3].revealed.length, 0);
});

test("a page over 512 KB says Too large to preview instead, and what isn't a preview opens nothing", () => {
  assert.equal(preview.PREVIEW_LIMIT, 512 * 1024);
  const big = "<p>" + "x".repeat(512 * 1024) + "</p>";
  preview.openCodePreview(ask({ html: big, css: [] }));
  let doc = parsed(world.panels[0].webview.html);
  assert.equal(doc.body.textContent.trim(), "Too large to preview");
  assert.equal(doc.querySelectorAll("iframe, input").length, 0);
  assert.equal(doc.querySelector('meta[http-equiv="Content-Security-Policy"]').getAttribute("content"), CSP);
  assert.equal(world.panels[0].webview.html.length < 4096, true, "the page itself is not in the tab");
  // The CSS counts, and so do bytes rather than characters.
  preview.openCodePreview(ask({ html: "<p>small</p>", css: ["a{}".repeat(100), "/*" + "é".repeat(260 * 1024) + "*/"] }));
  assert.equal(parsed(world.panels[1].webview.html).body.textContent.trim(), "Too large to preview");
  preview.openCodePreview(ask({ html: "<p>" + "x".repeat(500 * 1024) + "</p>", css: [] }));
  assert.equal(parsed(world.panels[2].webview.html).querySelectorAll("iframe").length, 2, "under the limit it is shown");
  const before = world.panels.length;
  for (const bad of [null, "codePreview", {}, { type: "codePreview" }, ask({ kind: "js" }), ask({ html: 7 }), ask({ html: "  " }), ask({ css: "a{}" }), ask({ css: [7] }), ask({ title: 7 })]) {
    assert.equal(preview.openCodePreview(bad), false);
  }
  assert.equal(world.panels.length, before);
  // A title is one short line of text, whatever was sent.
  preview.openCodePreview(ask({ title: "  A\n<b>title</b>  " + "z".repeat(300), html: "<p>t</p>" }));
  assert.match(world.panels.at(-1).title, /^Preview · A <b>title<\/b> z+$/);
  assert.equal(world.panels.at(-1).title.length <= 100, true);
  assert.equal(parsed(world.panels.at(-1).webview.html).querySelector("b"), null, "and it is text in the tab's own page");
});

test("each chat's host hands the message to the one opener", () => {
  const read = (name) => readFileSync(join(root, name), "utf8");
  assert.match(read("src/panel.ts"), /case "codePreview":\s*openCodePreview\(msg\);/);
  assert.match(read("src/chatdgc.ts"), /case "codePreview":\s*openCodePreview\(message\);/);
  assert.match(read("src/pipsView.ts"), /'codePreview'/, "a Pip's tab passes it on as it passes a link");
});
