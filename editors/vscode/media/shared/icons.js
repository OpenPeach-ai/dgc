// One action, one icon, on every surface (his call, 16 Nov): Open in editor, More, Back, Settings, New / Add, Close,
// Copy, Delete, Pin, Unpin, Archive, Stop and Save each have one glyph, the one Work draws, wherever the control is:
// Work's rows, header and menus, ChatDGC, a Pip's list, chat and page, Home, the Library, the dock and every row's "…"
// menu. A classic script, like media/shared/menu.js: the pages load it after menu.js and before their own script, and
// the Pips bundle imports it, so all share window.DgcIcons.
//
// Two ways to draw the same glyph, because a Pip's view in the side bar is in a shadow root the icon font's classes
// can't reach: html(action) is an inline drawing that works anywhere; codicon(action) is the icon font's name for the
// pages that draw with the font. The drawings below are the font's own outlines (media/codicon.ttf, on a 16-unit box),
// so the two are one shape; test/uir2c-icons.test.mjs paints both and compares them. Pin, Unpin and Archive are DGC's
// own line drawings (the font has no such pair), and More is the menus' three dots (DgcMenu.DOTS).
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcIcons) return;

  /** What each action draws. */
  const ACTIONS = { "open-in-editor": "go-to-file", more: "more", back: "arrow-left", settings: "settings-gear", add: "add", new: "add", close: "close", copy: "copy",
    delete: "trash", remove: "trash", pin: "pin", unpin: "unpin", archive: "archive", stop: "debug-stop", save: "desktop-download" };
  // The icon font's outlines, filled.
  const FONT = {
    "go-to-file": "M8.59 1.01Q9.23 1.01 9.65 1.44L12.59 4.37Q13.01 4.8 13.01 5.44V13.01Q13.01 13.81 12.43 14.4Q11.84 14.99 10.99 14.99H5.01Q4.16 14.99 3.57 14.4Q2.99 13.81 2.99 13.01V6.03H4V13.01Q4 13.44 4.29 13.73Q4.59 14.03 5.01 14.03H10.99Q11.41 14.03 11.71 13.73Q12 13.44 12 13.01V6.03H9.49Q8.85 6.03 8.43 5.57Q8 5.12 8 4.48V2.03L7.95 1.92Q7.84 1.65 7.63 1.44L7.2 1.01ZM9.01 4.48Q9.01 4.69 9.15 4.85Q9.28 5.01 9.49 5.01H11.79L9.01 2.19ZM4.48 0Q4.69 0 4.85 0.16L6.88 2.13Q6.93 2.24 6.96 2.32Q6.99 2.4 6.99 2.51Q6.99 2.61 6.96 2.69Q6.93 2.77 6.88 2.88L4.85 4.85Q4.69 5.01 4.51 5.01Q4.32 5.01 4.16 4.85Q4 4.69 4 4.51Q4 4.32 4.16 4.16L5.28 2.99H2.51Q1.87 2.99 1.44 3.44Q1.01 3.89 1.01 4.48V5.49Q1.01 5.71 0.85 5.87Q0.69 6.03 0.48 6.03Q0.27 6.03 0.13 5.87Q0 5.71 0 5.49V4.48Q0 3.47 0.72 2.75Q1.44 2.03 2.51 2.03H5.28L4.16 0.85Q4 0.69 4 0.51Q4 0.32 4.16 0.16Q4.32 0 4.48 0Z",
    "arrow-left": "M13.49 8H3.73L7.84 3.84Q8 3.73 8 3.52Q8 3.31 7.87 3.15Q7.73 2.99 7.52 2.99Q7.31 2.99 7.15 3.15L2.13 8.16Q1.97 8.32 1.97 8.51Q1.97 8.69 2.13 8.85L7.15 13.87Q7.31 14.03 7.49 14.03Q7.68 14.03 7.84 13.87Q8 13.71 8 13.49Q8 13.28 7.84 13.17L3.73 9.01H13.49Q13.71 9.01 13.87 8.85Q14.03 8.69 14.03 8.51Q14.03 8.32 13.87 8.16Q13.71 8 13.49 8Z",
    "settings-gear": "M8 5.97Q7.15 5.97 6.59 6.56Q6.03 7.15 6.03 8Q6.03 8.85 6.59 9.41Q7.15 9.97 8 9.97Q8.85 9.97 9.44 9.41Q10.03 8.85 10.03 8Q10.03 7.15 9.44 6.56Q8.85 5.97 8 5.97ZM8 9.01Q7.57 9.01 7.28 8.72Q6.99 8.43 6.99 8Q6.99 7.57 7.28 7.28Q7.57 6.99 8 6.99Q8.43 6.99 8.72 7.28Q9.01 7.57 9.01 8Q9.01 8.43 8.72 8.72Q8.43 9.01 8 9.01ZM14.56 9.71 13.28 8.64 13.17 8.53Q12.96 8.27 12.99 7.92Q13.01 7.57 13.28 7.36L14.56 6.29Q14.77 6.13 14.67 5.87Q14.24 4.43 13.23 3.31Q13.12 3.15 12.91 3.15L12.75 3.2L11.04 3.79H10.93Q10.61 3.79 10.37 3.6Q10.13 3.41 10.08 3.15L9.81 1.49Q9.76 1.23 9.49 1.17Q8.75 1.01 8 1.01Q7.25 1.01 6.51 1.17Q6.24 1.23 6.19 1.49L5.87 3.25Q5.76 3.52 5.55 3.65Q5.33 3.79 5.12 3.79Q4.96 3.79 4.8 3.79L3.25 3.2L3.09 3.15Q2.88 3.15 2.77 3.31Q1.76 4.43 1.33 5.87Q1.23 6.13 1.44 6.29L2.83 7.47Q3.04 7.73 3.01 8.08Q2.99 8.43 2.72 8.64L1.44 9.71Q1.23 9.92 1.33 10.13Q1.76 11.57 2.77 12.69Q2.88 12.85 3.09 12.85L3.25 12.8L4.96 12.21H5.12Q5.39 12.21 5.63 12.4Q5.87 12.59 5.92 12.85L6.19 14.51Q6.24 14.77 6.51 14.83Q7.25 14.99 8 14.99Q8.75 14.99 9.49 14.83Q9.76 14.77 9.81 14.51L10.13 12.75Q10.24 12.48 10.45 12.35Q10.67 12.21 10.93 12.21Q11.04 12.21 11.2 12.21L12.75 12.8L12.91 12.85Q13.12 12.85 13.23 12.69Q14.24 11.57 14.67 10.13Q14.77 9.92 14.56 9.71ZM12.75 11.73 11.52 11.31Q11.2 11.2 10.93 11.2Q10.35 11.2 9.87 11.52Q9.39 11.84 9.17 12.37L9.12 12.69L8.91 13.92Q8.43 13.97 8 13.97Q7.57 13.97 7.15 13.92L6.88 12.69Q6.77 12.05 6.27 11.63Q5.76 11.2 5.12 11.2H4.75L4.48 11.31L3.25 11.73Q2.72 11.04 2.4 10.24L3.36 9.39Q3.95 8.91 4 8.16Q4.05 7.41 3.57 6.83L3.36 6.61L2.4 5.76Q2.72 4.96 3.25 4.27L4.48 4.69Q4.8 4.8 5.12 4.8Q5.65 4.8 6.13 4.48Q6.61 4.16 6.83 3.63L6.88 3.31L7.15 2.08Q7.57 1.97 8 1.97Q8.43 1.97 8.91 2.08L9.12 3.31Q9.23 3.95 9.73 4.37Q10.24 4.8 10.88 4.8H11.25L11.52 4.69L12.75 4.27Q13.28 4.96 13.6 5.76L12.64 6.61Q12.05 7.09 12 7.84Q11.95 8.59 12.43 9.17L12.64 9.39L13.6 10.19Q13.28 11.04 12.75 11.73Z",
    "add": "M8 1.49Q8 1.28 7.87 1.15Q7.73 1.01 7.52 1.01Q7.31 1.01 7.15 1.15Q6.99 1.28 6.99 1.49V6.99H1.49Q1.28 6.99 1.15 7.15Q1.01 7.31 1.01 7.52Q1.01 7.73 1.15 7.87Q1.28 8 1.49 8H6.99V13.49Q6.99 13.71 7.15 13.84Q7.31 13.97 7.52 13.97Q7.73 13.97 7.87 13.84Q8 13.71 8 13.49V8H13.49Q13.71 8 13.87 7.87Q14.03 7.73 14.03 7.52Q14.03 7.31 13.87 7.15Q13.71 6.99 13.49 6.99H8Z",
    "close": "M8.69 8 12.37 4.37Q12.48 4.21 12.48 4Q12.48 3.79 12.35 3.65Q12.21 3.52 12 3.52Q11.79 3.52 11.63 3.63L8 7.31L4.37 3.63Q4.21 3.52 4 3.52Q3.79 3.52 3.65 3.65Q3.52 3.79 3.52 4Q3.52 4.21 3.63 4.37L7.31 8L3.63 11.63Q3.52 11.79 3.52 12Q3.52 12.21 3.65 12.35Q3.79 12.48 4 12.48Q4.21 12.48 4.37 12.37L8 8.69L11.63 12.37Q11.79 12.48 12 12.48Q12.21 12.48 12.35 12.35Q12.48 12.21 12.48 12Q12.48 11.79 12.37 11.63Z",
    "copy": "M2.99 5.01V12.75Q2.56 12.48 2.29 12Q2.03 11.52 2.03 10.99V5.01Q2.03 3.89 2.56 2.99Q3.09 2.08 4 1.55Q4.91 1.01 6.03 1.01H9.01Q9.55 1.01 10 1.28Q10.45 1.55 10.72 1.97H6.03Q4.75 1.97 3.87 2.88Q2.99 3.79 2.99 5.01ZM10.99 14.99H6.03Q5.17 14.99 4.59 14.4Q4 13.81 4 13.01V5.01Q4 4.16 4.59 3.57Q5.17 2.99 5.97 2.99H10.99Q11.84 2.99 12.43 3.57Q13.01 4.16 13.01 5.01V13.01Q13.01 13.81 12.43 14.4Q11.84 14.99 10.99 14.99ZM12 5.01Q12 4.59 11.71 4.29Q11.41 4 10.99 4H6.03Q5.6 4 5.31 4.29Q5.01 4.59 5.01 5.01V13.01Q5.01 13.44 5.31 13.71Q5.6 13.97 6.03 13.97H10.99Q11.41 13.97 11.71 13.71Q12 13.44 12 13.01Z",
    "trash": "M14.03 1.97H10.03Q9.97 1.17 9.41 0.59Q8.85 0 8 0Q7.15 0 6.59 0.59Q6.03 1.17 6.03 2.03H2.03Q1.81 1.97 1.65 2.13Q1.49 2.29 1.49 2.51Q1.49 2.72 1.65 2.85Q1.81 2.99 2.03 2.99H2.56L3.36 12.69Q3.41 13.65 4.13 14.32Q4.85 14.99 5.81 14.99H10.13Q11.15 14.99 11.87 14.32Q12.59 13.65 12.64 12.69L13.44 2.99H13.97Q14.19 2.99 14.35 2.85Q14.51 2.72 14.51 2.51Q14.51 2.29 14.35 2.13Q14.19 1.97 13.97 2.03H14.03ZM8 1.01Q8.43 1.01 8.72 1.31Q9.01 1.6 9.01 2.03H6.99Q6.99 1.6 7.28 1.31Q7.57 1.01 8 1.01ZM11.68 12.64Q11.63 13.23 11.17 13.63Q10.72 14.03 10.13 14.03H5.87Q5.28 13.97 4.83 13.6Q4.37 13.23 4.32 12.64L3.52 2.99H12.48ZM6.99 5.49V11.52Q6.99 11.73 6.85 11.87Q6.72 12 6.51 12Q6.29 12 6.13 11.87Q5.97 11.73 5.97 11.52V5.49Q6.03 5.28 6.16 5.15Q6.29 5.01 6.51 5.01Q6.72 5.01 6.85 5.15Q6.99 5.28 6.99 5.49ZM10.03 5.49V11.52Q10.03 11.73 9.87 11.87Q9.71 12 9.49 12Q9.28 12 9.15 11.87Q9.01 11.73 9.01 11.52V5.49Q9.01 5.28 9.15 5.15Q9.28 5.01 9.49 5.01Q9.71 5.01 9.84 5.15Q9.97 5.28 9.97 5.49Z",
    "debug-stop": "M12.48 3.52V12.48H3.52V3.52ZM12.48 1.97H3.52Q2.88 1.97 2.45 2.43Q2.03 2.88 1.97 3.52V12.48Q2.03 13.12 2.45 13.57Q2.88 14.03 3.52 14.03H12.48Q13.12 13.97 13.57 13.55Q14.03 13.12 13.97 12.48V3.52Q14.03 2.88 13.57 2.45Q13.12 2.03 12.48 2.03Z",
    "desktop-download": "M16 13.49Q16 13.6 15.97 13.68Q15.95 13.76 15.84 13.87L13.87 15.84Q13.76 15.95 13.68 15.97Q13.6 16 13.49 16Q13.39 16 13.31 15.97Q13.23 15.95 13.17 15.84L11.15 13.87Q11.09 13.76 11.04 13.68Q10.99 13.6 10.99 13.49Q10.99 13.39 11.04 13.31Q11.09 13.23 11.15 13.15Q11.2 13.07 11.31 13.04Q11.41 13.01 11.49 13.01Q11.57 13.01 11.68 13.04Q11.79 13.07 11.84 13.17L13.01 14.29V9.49Q13.01 9.28 13.15 9.15Q13.28 9.01 13.49 9.01Q13.71 9.01 13.87 9.15Q14.03 9.28 14.03 9.49V14.29L15.15 13.17Q15.2 13.07 15.31 13.04Q15.41 13.01 15.49 13.01Q15.57 13.01 15.68 13.04Q15.79 13.07 15.87 13.15Q15.95 13.23 15.97 13.31Q16 13.39 16 13.49ZM10.99 12H12V10.99H2.99Q2.56 10.99 2.29 10.69Q2.03 10.4 2.03 9.97V2.99Q2.03 2.56 2.29 2.27Q2.56 1.97 2.99 1.97H13.01Q13.44 2.03 13.73 2.29Q14.03 2.56 14.03 2.99V8H14.99V2.99Q14.99 2.19 14.4 1.6Q13.81 1.01 13.01 1.01H2.99Q2.19 1.01 1.6 1.6Q1.01 2.19 1.01 2.99V9.97Q1.01 10.83 1.6 11.41Q2.19 12 2.99 12H5.01V13.97H3.52Q3.31 13.97 3.15 14.13Q2.99 14.29 2.99 14.51Q2.99 14.72 3.15 14.85Q3.31 14.99 3.52 14.99H10.03V13.97H6.03V12H10.03V13.49Q9.97 13.17 10.11 12.91Q10.24 12.64 10.43 12.45Q10.61 12.27 10.88 12.11H10.99Z",
  };
  // DGC's own drawings, in a 1.3 line.
  const PIN = "M10.2 1.8l4 4-2.2.9-2.4 2.4.3 3.1-1.1 1.1-2.6-2.6L2.8 14l-.8-.8 3.3-3.4-2.6-2.6 1.1-1.1 3.1.3 2.4-2.4z";
  const LINE = {
    pin: `<path d="${PIN}"/>`,
    unpin: `<path d="${PIN}"/>`,          // (the pin, solid: it is pinned, and pressing it unpins)
    archive: '<path d="M2 3.5h12v3H2zM3.2 6.5V13h9.6V6.5M6.5 9.2h3"/>',
  };
  const DOTS = '<circle cx="3.5" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor"/>';
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /** The glyph an action draws ("go-to-file"), or "" for an action that isn't one of these. A glyph's own name is itself. */
  const name = (action) => ACTIONS[action] || (FONT[action] || LINE[action] || action === "more" ? action : "");
  /** The icon font's name for an action's glyph, for a page that draws with the font; "" when the glyph is DGC's own drawing. */
  const codicon = (action) => (FONT[name(action)] ? name(action) : "");
  /**
   * The glyph as an inline drawing, in the text's colour. size: 16 in a header or a row's button (the default), 15 in a
   * menu's row. cls: more classes for the drawing.
   */
  function html(action, { size = 0, cls = "" } = {}) {
    const glyph = name(action);
    if (!glyph) return "";
    // (More is the menus' three dots, 14 on its box wherever it is: the same drawing as DgcMenu.DOTS.)
    const px = Number(size) || (glyph === "more" ? 14 : 16);
    const head = `<svg class="dgc-icon${cls ? ` ${esc(cls)}` : ""}" data-icon="${glyph}" viewBox="0 0 16 16" width="${px}" height="${px}" aria-hidden="true" focusable="false"`;
    if (glyph === "more") return `${head}>${DOTS}</svg>`;
    if (FONT[glyph]) return `${head} fill="currentColor"><path d="${FONT[glyph]}"/></svg>`;
    return `${head} fill="${glyph === "unpin" ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${LINE[glyph]}</svg>`;
  }
  /** The same, as an element of `doc`. */
  function node(action, opts = {}, doc = root.document) {
    const box = doc.createElement("template"); box.innerHTML = html(action, opts);
    return box.content.firstElementChild;
  }
  /** The action a control's name says ("Open in editor: Fix the login" is Open in editor), or "". */
  function forLabel(label) {
    const w = String(label || "").replace(/\s+/g, " ").trim().toLowerCase();
    if (/^open (it )?in (the |an )?editor\b/.test(w)) return "open-in-editor";
    if (/^more\b/.test(w) || w === "…" || w === "...") return "more";
    if (/^back\b/.test(w)) return "back";
    if (/^(new|add)\b/.test(w)) return "add";
    if (/^close\b/.test(w)) return "close";
    if (/^copy\b/.test(w)) return "copy";
    if (/^(delete|remove)\b/.test(w)) return "delete";
    if (/^pin\b/.test(w)) return "pin";
    if (/^unpin\b/.test(w)) return "unpin";
    if (/^archive\b/.test(w)) return "archive";
    if (/^stop\b/.test(w)) return "stop";
    if (/^save to (the )?project\b/.test(w)) return "";
    if (/^save\b/.test(w)) return "save";
    if (/\bsettings\b/.test(w)) return "settings";
    return "";
  }

  root.DgcIcons = { ACTIONS, html, node, name, codicon, forLabel, has: (action) => !!name(action) };
})();
