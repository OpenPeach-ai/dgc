// A softly layered, kind-coloured sheet with its name on a tab: a page has a browser bar, slides a
// frame, a sheet a grid, a dashboard tiles and bars. One piece for the output card in Work, ChatDGC and a Pip's chat
// and for the Library's rows (media/shared/filesheet.css is how it looks). The colour marks the kind only. A classic
// script: Work's and ChatDGC's pages load it before their own script, and the Pips bundle imports it, so all share
// window.DgcFileSheet.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcFileSheet) return;

  // The kinds DGC really makes or shows, and the word on each one's tab. The tab's colour is the kind's, in the CSS.
  const KINDS = { page: "Page", doc: "Doc", slides: "Slides", sheet: "Sheet", dashboard: "Board", checklist: "List", design: "Design", pdf: "PDF", md: "MD", csv: "CSV",
    img: "PNG", video: "MP4", code: "Code", json: "JSON", zip: "ZIP", file: "File" };
  // A file's ending, or what DGC calls it (an artifact's type, a made file's format, a Library file's type), to its kind.
  // An ending that has its own name on the tab keeps it ("DOCX" on a document's sheet, "JPG" on a picture's).
  const BY_NAME = { page: "page", html: "page", htm: "page", doc: "doc", document: "doc", docx: "doc", txt: "doc", text: "doc", slides: "slides", presentation: "slides", pptx: "slides",
    sheet: "sheet", spreadsheet: "sheet", xlsx: "sheet", dashboard: "dashboard", checklist: "checklist", design: "design", pdf: "pdf", md: "md", markdown: "md", csv: "csv", tsv: "csv",
    img: "img", image: "img", png: "img", jpg: "img", jpeg: "img", webp: "img", gif: "img", svg: "img", heic: "img",
    video: "video", mp4: "video", webm: "video", mov: "video", code: "code", json: "json", zip: "zip", archive: "zip" };
  const CODE = /^(?:js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|swift|c|h|cpp|cs|php|sh|css|scss|sql|yaml|yml|toml|xml|vue|lua)$/;
  const OWN_TAG = /^(?:docx|pptx|xlsx|tsv|png|jpg|jpeg|webp|gif|svg|heic|mp4|webm|mov|html|txt)$/;
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * Which sheet a thing gets: { kind, tag }. `what` is its type or format ("slides", "docx", "image"); `name` is its
   * file name when it has one, whose ending wins for a plain file ("report.pdf", "auth/redirect.ts").
   */
  function of(what, name) {
    const ending = /\.([A-Za-z0-9]{1,5})$/.exec(String(name || ""))?.[1]?.toLowerCase() || "";
    const said = String(what || "").toLowerCase();
    // What DGC made (an artifact's type) names its kind outright; a file is named by its ending first.
    const key = ["page", "doc", "slides", "sheet", "dashboard", "checklist", "design"].includes(said) ? said : BY_NAME[ending] || CODE.test(ending) ? ending : said;
    const kind = BY_NAME[key] || (CODE.test(key) ? "code" : "file");
    const tag = kind === "code" && CODE.test(key) ? key.toUpperCase() : OWN_TAG.test(key) ? (key === "jpeg" ? "JPG" : key.toUpperCase()) : KINDS[kind];
    return { kind, tag };
  }

  const l = (w, cls = "") => `<i class="l w${w}${cls ? ` ${cls}` : ""}"></i>`;
  const times = (n, s) => Array.from({ length: n }, (_, i) => (typeof s === "function" ? s(i) : s)).join("");
  // Each kind keeps its miniature layout; CSS supplies the coloured paper and contrasting content marks.
  const BODY = {
    page: () => `<span class="dots"><i></i><i></i><i></i></span><i class="box hero"></i>${l(70, "h")}${l(90, "s")}${l(55, "s")}<span class="rw fill"><i class="box"></i><i class="box"></i></span>`,
    doc: () => `${l(60, "h")}${l(90)}${l(80)}${l(90)}${l(45)}<i class="gap"></i>${l(85)}${l(70)}${l(90)}${l(30)}`,
    slides: () => `<span class="box stage"><i class="mark"></i><i class="l w55 h"></i></span><span class="rw fill"><i class="box"></i><i class="box"></i><i class="box"></i></span>${l(60, "s")}${l(40, "s")}`,
    sheet: () => `<span class="grid">${times(3, '<i class="hd"></i>')}${times(15, "<i></i>")}</span>`,
    dashboard: () => `<span class="rw fill tall"><i class="box"></i><i class="box"></i></span><span class="box bars">${times(6, (i) => `<i class="b${i}"></i>`)}</span>`,
    checklist: () => `${l(55, "h")}${times(4, (i) => `<span class="rw tick${i < 2 ? " on" : ""}"><i class="cb"></i>${l([70, 55, 75, 45][i])}</span>`)}`,
    design: () => `<span class="rw fill boards"><i class="box wide"></i><i class="box tall"></i></span>${l(45, "s")}`,
    pdf: () => `${l(50, "h")}${l(90)}${l(85)}${l(90)}${l(60)}<i class="box block"></i>${l(80)}${l(40)}`,
    md: () => `<span class="rw"><b>#</b>${l(45, "h")}</span>${l(85)}${l(70)}<span class="rw"><b>##</b>${l(35, "h")}</span>${l(80)}${l(55)}`,
    csv: () => `<span class="rw">${times(3, l(30, "h"))}</span>${times(6, `<span class="rw">${times(3, l(30))}</span>`)}`,
    img: () => `<span class="box pic"><i class="sun"></i><i class="hill"></i><i class="hill far"></i></span>${l(60, "s")}`,
    video: () => `<span class="box play"><i></i></span><span class="rw"><i class="l w40 h tint"></i>${l(55, "s")}</span>`,
    code: () => [[1, 30, 2, 35], [2, 20, 3, 50], [0, 0, 4, 60], [0, 0, 5, 45], [1, 25, 2, 30], [0, 0, 0, 20]]
      .map(([a, w1, b, w2]) => `<span class="rw${a ? "" : " in"}">${a ? `<i class="l w${w1} c${a}"></i>` : ""}<i class="l w${w2}${b ? ` c${b}` : ""}"></i></span>`).join(""),
    json: () => `<b>{</b>${[[30, 45], [25, 35], [35, 25], [20, 50]].map(([a, b]) => `<span class="rw in">${l(a, "h")}${l(b)}</span>`).join("")}<b>}</b>`,
    zip: () => `<span class="zip">${times(8, (i) => `<i class="z${i % 2}"></i>`)}<i class="pull"></i></span>`,
    file: () => `${l(60, "h")}${l(90)}${l(80)}${l(90)}${l(45)}`,
  };

  /** The sheet as HTML. `kind` is one of KINDS (or anything `of` reads); `tag` replaces the word on its tab. */
  function html(kind, { tag, name } = {}) {
    const known = Object.hasOwn(BODY, kind) ? { kind, tag: KINDS[kind] } : of(kind, name);
    return `<span class="dgc-sheet" data-kind="${known.kind}" aria-hidden="true"><span class="dgc-sheet-page">${BODY[known.kind]()}</span>`
      + `<span class="dgc-sheet-tag">${esc(String(tag || known.tag).slice(0, 6))}</span></span>`;
  }
  /** The same, for a thing named by its type and file name ("docx", "report.docx"). */
  const forFile = (what, name) => { const k = of(what, name); return html(k.kind, { tag: k.tag }); };

  const svg = (d) => `<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  // Download (and Save a copy): one action, one glyph on every surface, the icon module's own (media/shared/icons.js);
  // the same drawing here only while that module has not loaded.
  const download = () => root.DgcIcons?.html("download", { size: 14 }) || svg('<path d="M8 2.5v8M4.8 7.5 8 10.7l3.2-3.2M3 13h10"/>');
  const OPEN = svg('<path d="M9 3h4v4M13 3 7.5 8.5M11.5 9.5V13H3V4.5h4"/>');
  /** The card's visible Open (the card's own Open button lies over all of it, so this one is only seen). */
  const openPill = () => `<span class="dgc-doc-open-pill" aria-hidden="true">${OPEN}Open</span>`;

  root.DgcFileSheet = Object.freeze({ KINDS, of, html, forFile, openPill, get DOWNLOAD() { return download(); }, OPEN });
})();
