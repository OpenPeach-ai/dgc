// The small sheet of a thing DGC made or shows (media/shared/filesheet.js and filesheet.css, approved 11 Nov): one piece
// for the output card in Work, ChatDGC and a Pip's chat and for the Library's rows. Every kind had the same blue tile
// with a page glyph before; now a page, a document, slides, a sheet and a dashboard each have their own sheet and tab.
// Here: which sheet a thing gets, its markup, that every page loads it, and that its colours mark the kind only.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url)), read = (f) => readFileSync(root + f, "utf8");
const w = new JSDOM("<!doctype html><body></body>", { runScripts: "outside-only" }).window;
after(() => w.close());
w.eval(read("media/shared/filesheet.js"));
const S = w.DgcFileSheet, css = read("media/shared/filesheet.css");

test("what DGC makes names its kind; a file is named by its ending, which is the word on its tab", () => {
  const of = (what, name) => { const k = S.of(what, name); return [k.kind, k.tag]; };
  assert.deepEqual([of("page"), of("doc"), of("slides"), of("sheet"), of("dashboard")], [["page", "Page"], ["doc", "Doc"], ["slides", "Slides"], ["sheet", "Sheet"], ["dashboard", "Board"]]);
  assert.deepEqual(of("doc", "Notes v1.2"), ["doc", "Doc"], "a title that ends like a file is still what DGC made");
  assert.deepEqual([of("docx", "review.docx"), of("xlsx"), of("pptx"), of("pdf"), of("csv"), of("md", "notes.md")], [["doc", "DOCX"], ["sheet", "XLSX"], ["slides", "PPTX"], ["pdf", "PDF"], ["csv", "CSV"], ["md", "MD"]]);
  assert.deepEqual([of("image", "map.jpeg"), of("png"), of("video", "clip.mp4"), of("code", "auth/redirect.ts"), of("code"), of("document", "data.json"), of("file", "site.zip")],
    [["img", "JPG"], ["img", "PNG"], ["video", "MP4"], ["code", "TS"], ["code", "Code"], ["json", "JSON"], ["zip", "ZIP"]]);
  assert.deepEqual([of("spreadsheet", "orders"), of("presentation"), of("text", "Hotel")], [["sheet", "Sheet"], ["slides", "Slides"], ["doc", "Doc"]], "the Library's own type names");
  assert.deepEqual(of("something else", "thing"), ["file", "File"], "anything else is a plain sheet");
});

test("a sheet is a page with its kind's shape and a tab; nothing a caller passes is markup", () => {
  for (const kind of Object.keys(S.KINDS)) {
    w.document.body.innerHTML = S.html(kind);
    const sheet = w.document.querySelector(".dgc-sheet");
    assert.equal(sheet.dataset.kind, kind);
    assert.equal(sheet.getAttribute("aria-hidden"), "true", "a mark: the card's words say what it is");
    assert.ok(sheet.querySelector(".dgc-sheet-page").children.length > 0, `${kind}: its shape`);
    assert.equal(sheet.querySelector(".dgc-sheet-tag").textContent, S.KINDS[kind]);
    assert.doesNotMatch(sheet.outerHTML, /style=/, `${kind}: drawn by the stylesheet, no inline styles`);
    if (kind !== "file" && kind !== "md") assert.match(css, new RegExp(`\\[data-kind="${kind}"\\] \\{ --sheet-c: #[0-9A-F]{6}; \\}`), `${kind}: its own tab colour`);
  }
  const shapes = new Set(Object.keys(S.KINDS).map((k) => S.html(k).replace(/<span class="dgc-sheet-tag">.*$/, "").replace(/data-kind="\w+"/, "")));
  assert.ok(shapes.size >= Object.keys(S.KINDS).length - 1, "the kinds are told apart by shape, not only by the tab");
  w.document.body.innerHTML = S.html("doc", { tag: "<b>x</b>" });
  assert.equal(w.document.querySelector(".dgc-sheet-tag b"), null);
  w.document.body.innerHTML = S.forFile("docx", 'a"><img src=x>.docx');
  assert.equal(w.document.querySelector("img"), null);
});

test("the approved tab colours, and none of them is the accent", () => {
  const colours = { page: "#EA580C", doc: "#2563EB", slides: "#D97706", sheet: "#059669", dashboard: "#0891B2", pdf: "#DC2626", md: "#525252", csv: "#0F766E", img: "#DB2777", video: "#15803D", code: "#475569", json: "#CA8A04", zip: "#A16207" };
  for (const [kind, c] of Object.entries(colours)) assert.ok(css.includes(`.dgc-sheet[data-kind="${kind}"] { --sheet-c: ${c}; }`), `${kind} is ${c}`);
  assert.doesNotMatch(css.replace(/\/\*[\s\S]*?\*\//g, ""), /--accent|--link|--lav|#7C5CFF|#A78BFA|#7654F6/i, "purple stays for Send and live marks");
  // The card's buttons are in the editor's greys: Open is the text colour, Download a hairline ring.
  const card = read("media/shared/doccard.css").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(card, /\.dgc-doc-open-pill \{[^}]*background: var\(--solid\); color: var\(--on-solid\)/);
  assert.match(card, /button\.dgc-doc-dl:not\(\.dgc-doc-open\) \{[^}]*border: 1px solid var\(--hair-strong\)[^}]*background: transparent; color: var\(--text\)/);
  assert.match(card, /@container \(max-width: 380px\) \{ \.dgc-doc-card \.dgc-doc-open-pill \{ display: none; \} \}/, "narrow: no Open pill");
});

test("every page loads the sheet: Work, ChatDGC and the Library before their own script, the Pips in their bundle", () => {
  const panel = read("src/panel.ts");
  assert.ok(panel.indexOf('src="${sheetJs}"') > 0 && panel.indexOf('src="${sheetJs}"') < panel.indexOf('src="${js}"'), "Work: filesheet.js before main.js");
  const chat = read("src/chatdgc.ts"), first = chat.indexOf('asset("media/shared/filesheet.js")'), second = chat.indexOf('asset("media/shared/filesheet.js")', first + 1);
  assert.ok(first > 0 && first < chat.indexOf('asset("media/chatdgc.js")'), "ChatDGC: before chatdgc.js");
  assert.ok(second > 0 && second < chat.indexOf('asset("media/library.js")', second), "the Library: before library.js");
  assert.match(read("src/pipsClient.js"), /import '\.\.\/media\/shared\/filesheet\.css';\nimport '\.\.\/media\/shared\/filesheet\.js';/);
  assert.match(read("media/main.css"), /@import url\("\.\/shared\/filesheet\.css"\);/);
  // Each card and row draws it through the one helper.
  for (const [file, n] of [["media/main.js", 1], ["media/chatdgc.js", 3], ["src/pipRunPosts.js", 1], ["media/library.js", 1]])
    assert.ok((read(file).match(/DgcFileSheet/g) || []).length >= n, `${file} draws its mark with the shared sheet`);
});
