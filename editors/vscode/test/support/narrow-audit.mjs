// The narrowest-width rule's measuring stick (live round 1, finding 28, 14 Nov): one walk of a page as it is drawn,
// through every shadow root, returning what breaks the rule. `narrowAudit` runs in the page (page.evaluate).
//   broken    a word drawn on more than one line (a heading stacked one letter per line, "Workflow / s"): a word wider
//             than its box. Ordinary words anywhere; a path, an address or a model's name only in a heading or a button
//             (in running text those may wrap where they must).
//   cut       a word cut off part-way by a box that hides what runs over, with no "…" ("Trace" shown as "Tr").
//   clipped   a button whose own words are cut, "…" or not ("Allow…", "Not n…" on a Pip's site card at 170 px: live
//             round 1, finding 45). A button's words are a command: at the narrowest the buttons go one under the
//             other or become icons, and never lose letters. Not a name a button shows (the value of a dropdown, a
//             tab's or a chat's title, a menu's row, a maker's name): those may end in "…".
//   sideways  a box with a sideways scrollbar of its own, and the page itself running off sideways.
//   inner     a Home card that scrolls by itself (the Needs you card's own scrollbar).
// Not a *.test.mjs file.
export const narrowAudit = (opts = {}) => {
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
  const ROOTS = (() => { const list = [document]; const walk = (root) => { for (const n of root.querySelectorAll("*")) if (n.shadowRoot) { list.push(n.shadowRoot); walk(n.shadowRoot); } }; walk(document); return list; })();
  const scopeEl = opts.scope ? ROOTS.flatMap((r) => [...r.querySelectorAll(opts.scope)])[0] : null;
  const within = (n) => { if (!scopeEl) return true; for (let p = n; p; p = up(p)) if (p === scopeEl) return true; return false; };
  const name = (e) => { const one = (n) => n.tagName.toLowerCase() + (n.id ? `#${n.id}` : "") + [...n.classList].slice(0, 3).map((c) => `.${c}`).join(""); const parts = []; for (let n = e, k = 0; n && k < 3; n = up(n), k++) parts.unshift(one(n)); return parts.join(" > "); };
  const shown = (e) => { if (!e.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false; const b = e.getBoundingClientRect(); return b.width > 2 && b.height > 2; };
  // Out of sight by design: words for a screen reader only (a 1 px box), and anything under an ancestor drawn at nothing.
  const hiddenByDesign = (e) => { for (let p = e; p; p = up(p)) { const b = p.getBoundingClientRect(); if (b.width <= 2 || b.height <= 2) return true; const s = getComputedStyle(p); if (parseFloat(s.opacity) === 0 || s.clipPath !== "none" && /inset\(\s*(50|100)%/.test(s.clipPath)) return true; } return false; };
  // (A path, an address or a model's name may wrap where it must in running text, in a link and on a row; in a heading
  // or on a tab it ends in "…" instead.)
  const HEADING = "h1, h2, h3, h4, h5, h6, summary, legend, [role=tab], .dgc-pagehead-title, .set-title";
  const out = { broken: [], cut: [], clipped: [], sideways: [], inner: [], page: false, width: innerWidth };
  // A button that shows a name, not a command: what a dropdown has chosen, a tab, a row of a menu or a list, a title.
  const NAMED = "[aria-haspopup], [role=tab], [role=option], [role^=menuitem], [role=row], .thread-title, .lib-row-maker, .dgc-dock-item, [data-name]";
  // The button whose command these words are, or null: up to three plain words ("Allow this site", "Not now", "Always allow").
  const command = (el) => { const b = el.closest("button, [role=button]"); if (!b || b.closest(NAMED) || b.querySelector(NAMED)) return null;
    const label = (b.textContent || "").replace(/\s+/g, " ").trim(); return label && label.length <= 24 && label.split(" ").length <= 3 && /^[\p{L}’' …]+$/u.test(label) ? b : null; };
  const push = (list, item) => { if (!list.some((x) => x.what === item.what && x.text === item.text)) list.push(item); };
  const range = document.createRange();
  for (const root of ROOTS) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue; if (!text || !text.trim()) continue;
      const el = node.parentElement; if (!el || !within(el) || el.closest("script, style, textarea, option, noscript, title, [contenteditable='true']")) continue;
      if (!shown(el) || hiddenByDesign(el)) continue;
      // A path drawn by DGC's own path element is cut in its middle with its own "…" (media/shared: dgc-path). And a
      // drawn picture of a screen (What's new's slides) is a picture: its small words are cut as a screenshot's are.
      const path = !!el.closest("dgc-path, .dgc-path, .wn-picture");
      const style = getComputedStyle(el);
      // The words' own block: where an "…" would be drawn.
      let block = el; while (block && /^inline$|^contents$/.test(getComputedStyle(block).display) && up(block)) block = up(block);
      const bs = getComputedStyle(block), dots = bs.textOverflow === "ellipsis" && bs.overflowX !== "visible", clamp = bs.webkitLineClamp && bs.webkitLineClamp !== "none";
      const heading = !!el.closest(HEADING);
      // (Code, a command or an address inside running text wraps where it must: it is not a word.)
      const code = !!el.closest("code, pre, kbd, samp, a[href]");
      // A word, and the pieces a browser may break it into by itself (after a hyphen, a slash or a dash).
      for (const m of text.matchAll(/\S+/g)) {
        let at = m.index;
        for (const piece of m[0].split(/(?<=[-‐–—/])/)) {
          const start = at; at += piece.length; if (!piece) continue;
          range.setStart(node, start); range.setEnd(node, start + piece.length);
          const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5); if (!rects.length) continue;
          const tops = []; for (const r of rects) if (!tops.some((t) => Math.abs(t - r.top) <= r.height / 2)) tops.push(r.top);
          const core = piece.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
          if (tops.length > 1) {
            // An ordinary word: any in a heading, on a button or in a label; in running text one of up to nine
            // letters (a column of the narrowest side bar holds that many; a longer word may have to break there).
            const ordinary = /^[\p{L}\p{M}'’]+$/u.test(core) && core.length <= (el.closest(HEADING + ", button, label, [role=button], [role=menuitem], [role=option]") ? 24 : 9) || /^[\d.,%]+$/.test(core);
            if ((ordinary && !code || heading) && core.length > 1) push(out.broken, { what: name(el), text: piece, lines: tops.length, box: Math.round(block.getBoundingClientRect().width) });
            continue;
          }
          if (style.direction === "rtl" || core.length < 2) continue;
          const r = rects[0];
          for (let a = el; a; a = up(a)) {
            const s = getComputedStyle(a); if (s.overflowX === "visible") continue;
            const b = a.getBoundingClientRect(), right = b.left + a.clientLeft + a.clientWidth, left = b.left + a.clientLeft;
            const over = r.right - right, under = left - r.left;
            if ((over > 2 && r.left < right - 3) || (under > 2 && r.right > left + 3)) {      // part of the word shows, part does not
              if (/auto|scroll/.test(s.overflowX)) break;                                    // it scrolls: listed under sideways
              if (!(dots || clamp || path)) push(out.cut, { what: name(el), by: name(a), text: piece, hidden: Math.round(Math.max(over, under)) });
              else if (dots && command(el)) push(out.clipped, { what: name(command(el)), by: name(a), text: (command(el).textContent || "").replace(/\s+/g, " ").trim(), hidden: Math.round(Math.max(over, under)) });
              break;
            }
          }
        }
      }
    }
    for (const e of root.querySelectorAll("*")) {
      if (!within(e)) continue;
      const s = getComputedStyle(e);
      if (/auto|scroll/.test(s.overflowX) && e.clientWidth > 0 && e.scrollWidth > e.clientWidth + 1 && shown(e)) push(out.sideways, { what: name(e), text: `${e.scrollWidth} in ${e.clientWidth}px` });
      if (/auto|scroll/.test(s.overflowY) && e.scrollHeight > e.clientHeight && shown(e) && e.closest(".hc-grid .hc-card") && !e.closest(".hc-open") && !e.matches("textarea, [contenteditable='true']") && !e.querySelector("textarea, [contenteditable='true']"))   /* (a field you type in scrolls its own words) */ push(out.inner, { what: name(e), text: `${e.scrollHeight} in ${e.clientHeight}px` });
    }
  }
  out.page = document.documentElement.scrollWidth > document.documentElement.clientWidth + 1 || document.body.scrollWidth > document.body.clientWidth + 1;
  return out;
};
