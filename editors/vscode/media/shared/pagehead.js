// One header row for every page of the side bar (0.52, his words of 15 Nov: "make the work, chat and library match the
// Pip's style or vice versa"): the page's name at the left, ⋯ at the right, a line under it. Work, Chat, Library (in the
// side bar and in its editor tab) and Pips all draw theirs with this, so the four cannot drift apart again: one font
// size, weight and colour for the title, one height, one padding, one line (media/shared/pagehead.css). A classic
// script: the side bar's page and the Library's tab load it before their own, and the Pips bundle imports it, so all
// share window.DgcPageHead.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcPageHead) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  /** The three dots of every page's ⋯. */
  const DOTS = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="3.5" cy="8" r="1.25" fill="currentColor"/><circle cx="8" cy="8" r="1.25" fill="currentColor"/><circle cx="12.5" cy="8" r="1.25" fill="currentColor"/></svg>';
  /** The class every page's ⋯ wears, whatever element it is (a button here; Pips' is the <summary> of its Controls). */
  const MORE = "dgc-pagehead-more";

  /**
   * The header row as HTML.
   *   title:  the page's name (words, escaped here)
   *   level:  1 or 2: the heading's level (the look is the same)
   *   more:   { id, label, tip }: the ⋯ as a button that opens a menu
   *   rest:   in place of `more`, the page's own HTML after the title (Pips: its status dot and its Controls, whose
   *           <summary> wears DgcPageHead.MORE and holds DgcPageHead.DOTS; the dot's box wears "dgc-pagehead-aside")
   *   cls:    one more class for the <header> (a page's own hook; never a look of its own)
   */
  function html({ title, level = 2, more = null, rest = "", cls = "" } = {}) {
    const h = level === 1 ? "h1" : "h2";
    return `<header class="dgc-pagehead${cls ? ` ${esc(cls)}` : ""}"><${h} class="dgc-pagehead-title">${esc(title)}</${h}>`
      + (rest || '<span class="dgc-pagehead-gap" aria-hidden="true"></span>'
        + (more ? `<button type="button"${more.id ? ` id="${esc(more.id)}"` : ""} class="${MORE}" aria-haspopup="menu" aria-expanded="false" aria-label="${esc(more.label || `More for ${title}`)}" title="${esc(more.tip || more.label || "More")}">${DOTS}</button>` : ""))
      + "</header>";
  }

  root.DgcPageHead = Object.freeze({ html, DOTS, MORE });
})();
