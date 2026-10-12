// What fills a context window, drawn as Claude's Usage sheet draws it: a bar in one colour a part, then each part
// with its tokens and its share of the window, a part's tools or files one by one under it, then the room kept free
// before the chat is compacted, and what's free. ChatDGC, main DGC and Pips draw it alike (dgc/context_breakdown.py
// makes the list). Text only: a label or a name is never markup.
//
// The parts are folded under Details at first: the bar and what's free show at a glance, the list on a click. What
// was opened stays open while the page lives, since the meter redraws as a reply streams in.
(function () {
  let listOpen = false;
  const partsOpen = new Set();
  const remember = (details, onToggle) => details.addEventListener("toggle", () => onToggle(details.open));
  const fmt = (n) => {
    const v = Math.max(0, Number(n) || 0);
    if (v >= 1e6) return `${(v / 1e6).toFixed(1).replace(/\.0$/, "")}M`;
    if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, "")}k`;
    return String(Math.round(v));
  };
  const share = (n, of) => (of ? `${((Number(n) || 0) * 100 / of).toFixed(1)}%` : "");
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };

  function row(id, label, tokens, of, extra, tag = "div") {
    const line = el(tag, "bd-row");
    line.dataset.id = id;
    const dot = el("span", "bd-dot");
    dot.setAttribute("aria-hidden", "true");
    line.append(dot, el("span", "bd-label", label), el("span", "bd-num", fmt(tokens)), el("span", "bd-share", extra ?? share(tokens, of)));
    return line;
  }

  /** The breakdown as an element. `b`: {window, used, categories, buffer, free, deferred?}. */
  function render(b) {
    const box = el("div", "bd");
    const size = Math.max(0, Number(b?.window) || 0);
    const parts = Array.isArray(b?.categories) ? b.categories : [];
    const bar = el("div", "bd-bar");
    bar.setAttribute("role", "img");
    bar.setAttribute("aria-label", `${share(b?.used, size)} of the context window used: ` +
      parts.map((c) => `${c.label} ${fmt(c.tokens)}`).join(", "));
    for (const c of parts) {
      const seg = el("span", "bd-seg");
      seg.dataset.id = c.id;
      seg.style.width = `${Math.min(100, (Number(c.tokens) || 0) * 100 / (size || 1))}%`;
      bar.append(seg);
    }
    if (b?.buffer) {
      const seg = el("span", "bd-seg");
      seg.dataset.id = "buffer";
      seg.style.width = `${Math.min(100, b.buffer * 100 / (size || 1))}%`;
      bar.append(seg);
    }
    const list = el("div", "bd-list");
    for (const c of parts) {
      const nested = Array.isArray(c.items) && c.items.length;
      const line = row(c.id, c.label, c.tokens, size, undefined, nested ? "span" : "div");
      if (Array.isArray(c.items) && c.items.length) {
        // A part with things in it (tools, files): opened, each with its own tokens.
        const more = el("details", "bd-more");
        more.open = partsOpen.has(c.id);
        remember(more, (open) => { if (open) partsOpen.add(c.id); else partsOpen.delete(c.id); });
        const summary = el("summary", "");
        summary.append(line);
        line.querySelector(".bd-label").append(el("span", "bd-count", String(c.items.length)));
        const items = el("div", "bd-items");
        for (const item of c.items) {
          const it = el("div", "bd-item");
          it.append(el("span", "bd-item-name", item.name), el("span", "bd-num", fmt(item.tokens)));
          items.append(it);
        }
        more.append(summary, items);
        list.append(more);
      } else list.append(line);
    }
    if (b?.buffer) list.append(row("buffer", "Kept free for summarizing", b.buffer, size));
    list.append(row("free", "Free space", b?.free, size));
    for (const d of Array.isArray(b?.deferred) ? b.deferred : []) list.append(row("deferred", d.label, d.tokens, size, "—"));
    const details = el("details", "bd-details");
    details.open = listOpen;
    remember(details, (open) => { listOpen = open; });
    const toggle = el("summary", "bd-toggle");
    toggle.append(el("span", "bd-toggle-label", "Details"), el("span", "bd-toggle-free", `${fmt(b?.free)} free`));
    details.append(toggle, list);
    box.append(bar, details);
    return box;
  }

  window.DgcBreakdown = { render, fmt };
})();
