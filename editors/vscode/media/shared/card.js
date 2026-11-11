// One card for everything that asks you something or reports to you, in Work, ChatDGC and a Pip's chat: an icon, what
// it wants in a sentence, what exactly as chips on one line ("+N" for the rest), one filled answer and one quiet one,
// and the detail one click away, opening in place. media/shared/card.css is how it looks. A classic script: Work's and
// ChatDGC's pages load it before their own script, and the Pips bundle imports it, so all three share window.DgcCard.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcCard) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const svg = (d) => `<svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  // A card's mark says what kind of thing it is about. Marks are drawn in the text colour, never a hue.
  const ICONS = {
    web: '<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c-2 2-2 9 0 11M8 2.5c2 2 2 9 0 11"/>',
    search: '<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>',
    clock: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3.2l2 1.3"/>',
    repeat: '<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v2.8h-2.8"/>',
    model: '<rect x="4" y="4" width="8" height="8" rx="1.5"/><path d="M6.5 2v2M9.5 2v2M6.5 12v2M9.5 12v2M2 6.5h2M2 9.5h2M12 6.5h2M12 9.5h2"/>',
    name: '<path d="M3 13V3h6.5l3.5 3.5V13z"/><path d="M5.5 8h5M5.5 10.5h3"/>',
    app: '<rect x="2.5" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="9" y="2.5" width="4.5" height="4.5" rx="1"/><rect x="2.5" y="9" width="4.5" height="4.5" rx="1"/><path d="M11.25 9.2v4.1M9.2 11.25h4.1"/>',
    computer: '<rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M6 13.5h4M8 11v2.5"/>',
    send: '<path d="M13.5 2.5 7 9M13.5 2.5l-4 11-2.5-4.5-4.5-2.5z"/>',
    pay: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="M2 6.5h12M4.5 10h3"/>',
    key: '<circle cx="5.5" cy="10.5" r="2.5"/><path d="m7.3 8.7 5.2-5.2M10.5 5.5l1.5 1.5"/>',
    code: '<path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3M9 3.5l-2 9"/>',
    mail: '<rect x="2" y="3.5" width="12" height="9" rx="1.5"/><path d="m2.5 4.5 5.5 4.5 5.5-4.5"/>',
    calendar: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>',
    doc: '<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>',
    check: '<path d="m3.5 8.5 3 3 6-7"/>',
    ask: '<circle cx="8" cy="8" r="5.5"/><path d="M6.4 6.4a1.7 1.7 0 1 1 2.4 1.7c-.5.3-.8.6-.8 1.2M8 11.4v.1"/>',
    pip: '<circle cx="8" cy="8" r="5.5"/><path d="M6 7v1M10 7v1M6 10.2c1.2.9 2.8.9 4 0"/>',
    change: '<path d="M3 5.5h8M9 3l2.5 2.5L9 8M13 10.5H5M7 8l-2.5 2.5L7 13"/>',
  };
  const icon = (name) => svg(ICONS[name] || ICONS.change);
  const attrsHtml = (attrs) => Object.entries(attrs || {}).filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => (v === true ? ` ${esc(k)}` : ` ${esc(k)}="${esc(v)}"`)).join("");

  // Which cards have their detail open, by id: a page that redraws itself (a Pip's chat) keeps it open across a redraw.
  const opened = new Set();
  let serial = 0;

  /**
   * A card as HTML.
   *   id        names the card (its open detail is remembered by it); attrs/cls go on the box, label is its spoken name
   *   icon      a mark's name (see ICONS), or { html } for a surface's own mark ({ html, face: true } for a Pip's
   *             face, drawn larger and without a tile), or { text } for a letter
   *   title     what it wants, as one sentence; sub: one quiet line under it (why); count: "1 of 3"
   *   chips     what exactly: [{ label, icon?, title? } | "label"]; the ones that do not fit on a line fold into "+N"
   *   note      a quiet line (what else answering does); error: what went wrong, said in the card
   *   actions   [{ label, primary?, attrs?, disabled?, title? }]: one filled answer, the rest quiet
   *   actionsHtml  the page's own row of answers in their place (Home's icon row, media/shared/iconactions.js)
   *   details   { rows: [[name, value]], html?, link?: { label, attrs } }: opens in place from "Details"
   * Every string is escaped here; `details.html`, `icon.html` and `actionsHtml` are the caller's own markup.
   */
  function html(card) {
    const id = card.id === undefined || card.id === null ? `card-${++serial}` : String(card.id);
    const domId = `dgc-card-${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
    const d = card.details, hasDetails = !!d && ((d.rows && d.rows.length) || d.html || d.link);
    const open = hasDetails && (card.open === undefined ? opened.has(id) : !!card.open);
    const own = card.icon && typeof card.icon === "object", face = own && card.icon.face === true;
    const mark = own ? (card.icon.html ?? esc(card.icon.text)) : icon(card.icon);
    const chipsHtml = chips(card.chips, card.chipsLabel);
    const actions = (card.actions || []).filter(Boolean).map((a) => `<button type="button" class="dgc-card-btn${a.primary ? " primary" : ""}${a.cls ? ` ${esc(a.cls)}` : ""}"`
      + `${attrsHtml(a.attrs)}${a.title ? ` title="${esc(a.title)}"` : ""}${a.disabled ? " disabled" : ""}>${esc(a.label)}</button>`).join("") + (card.actionsHtml || "");
    const toggle = hasDetails ? `<button type="button" class="dgc-card-link dgc-card-toggle" id="${domId}-toggle" data-dgc-card-toggle="${esc(id)}" aria-expanded="${open}" aria-controls="${domId}-details">${open ? "Hide details" : "Details"}</button>` : "";
    const detailsHtml = hasDetails ? `<div class="dgc-card-details" id="${domId}-details"${open ? "" : " hidden"}>`
      + (d.rows && d.rows.length ? `<dl class="dgc-card-rows">${d.rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("")}</dl>` : "")
      + (d.html || "")
      + (d.link ? `<button type="button" class="dgc-card-link"${attrsHtml(d.link.attrs)}>${esc(d.link.label)}</button>` : "") + `</div>` : "";
    return `<section class="dgc-card${card.cls ? ` ${esc(card.cls)}` : ""}" data-dgc-card="${esc(id)}" role="group" aria-label="${esc(card.label || card.title)}"${attrsHtml(card.attrs)}>`
      + `<div class="dgc-card-head"><span class="dgc-card-icon${face ? " dgc-card-face" : ""}" aria-hidden="true">${mark}</span><div class="dgc-card-words"><strong class="dgc-card-title">${esc(card.title)}</strong>`
      + `${card.sub ? `<span class="dgc-card-sub">${esc(card.sub)}</span>` : ""}</div>${card.count ? `<span class="dgc-card-count">${esc(card.count)}</span>` : ""}</div>`
      + chipsHtml
      + (card.note ? `<p class="dgc-card-note">${esc(card.note)}</p>` : "")
      + detailsHtml
      + (card.error ? `<p class="dgc-card-error" role="alert">${esc(card.error)}</p>` : "")
      + (actions || toggle ? `<div class="dgc-card-actions">${actions}${toggle}</div>` : "")
      + `</section>`;
  }

  /** What exactly, as one line of chips: [{ label, icon?, title? } | "label"]. For a card with markup of its own. */
  function chips(list, label = "What exactly") {
    const shown = (list || []).map((c) => (typeof c === "string" ? { label: c } : c)).filter((c) => c && c.label !== undefined && c.label !== null && c.label !== "");
    return shown.length ? `<ul class="dgc-card-chips" aria-label="${esc(label)}">`
      + shown.map((c) => `<li class="dgc-chip" title="${esc(c.title || c.label)}">${c.icon ? icon(c.icon) : ""}<span>${esc(c.label)}</span></li>`).join("")
      + `<li class="dgc-chip dgc-chip-more" hidden></li></ul>` : "";
  }

  /** The same card as an element, for a page that builds nodes (Work). */
  function node(card, doc = root.document) {
    const t = doc.createElement("template");
    t.innerHTML = html(card);
    return t.content.firstElementChild;
  }

  /** Open or close a card's detail in place, from its Details button. Returns whether it is now open. */
  function toggle(button, force) {
    const card = button.closest(".dgc-card"), panel = card && card.querySelector(".dgc-card-details");
    if (!panel) return false;
    const open = force === undefined ? panel.hidden : !!force, id = button.getAttribute("data-dgc-card-toggle");
    panel.hidden = !open;
    button.setAttribute("aria-expanded", String(open));
    button.textContent = open ? "Hide details" : "Details";
    if (open) opened.add(id); else opened.delete(id);
    return open;
  }

  /** A click anywhere in a page: true when it was a card's Details button (and the card has been opened or closed). */
  function click(target) {
    const button = target && target.closest ? target.closest("[data-dgc-card-toggle]") : null;
    if (!button) return false;
    toggle(button);
    return true;
  }

  /** Esc inside an open card closes its detail and puts the keyboard back on Details. True when it did. */
  function key(event) {
    if (event.key !== "Escape" || !event.target || !event.target.closest) return false;
    const card = event.target.closest(".dgc-card"), button = card && card.querySelector("[data-dgc-card-toggle][aria-expanded=true]");
    if (!button) return false;
    toggle(button, false);
    button.focus({ preventScroll: true });
    return true;
  }

  /** Keep each card's chips on one line: the ones that do not fit are folded into a last chip, "+N". */
  function fit(within) {
    for (const row of (within || root.document).querySelectorAll(".dgc-card-chips")) {
      const more = row.querySelector(".dgc-chip-more"), chips = [...row.children].filter((c) => c !== more);
      if (!more || !chips.length || !row.clientWidth) continue;
      row.classList.add("is-measuring");
      for (const c of chips) c.hidden = false;
      more.hidden = true;
      let shown = chips.length;
      while (shown > 1 && row.scrollWidth > row.clientWidth + 1) {
        chips[--shown].hidden = true;
        more.hidden = false;
        more.textContent = `+${chips.length - shown}`;
        more.title = chips.slice(shown).map((c) => c.title || c.textContent).join(", ");
        more.setAttribute("aria-label", `and ${chips.length - shown} more`);
      }
      row.classList.remove("is-measuring");
    }
  }

  /** Refit the chips whenever the cards under `host` are redrawn or its width changes. `within` is the root to search
      (a shadow root, for Pips in the side bar). Returns a function that stops watching. */
  function watch(host, within = host) {
    const view = host.ownerDocument ? host.ownerDocument.defaultView : root;
    if (!view || !view.requestAnimationFrame) return () => {};
    let queued = false;
    const again = () => { if (queued) return; queued = true; view.requestAnimationFrame(() => { queued = false; fit(within); }); };
    const seen = view.MutationObserver ? new view.MutationObserver((list) => {
      // Our own folding changes `hidden` and the "+N" chip's words; only a redraw of the cards matters.
      if (list.some((m) => !(m.target.closest && m.target.closest(".dgc-card-chips")))) again();
    }) : null;
    seen?.observe(within, { childList: true, subtree: true });
    const sized = view.ResizeObserver ? new view.ResizeObserver(again) : null;
    sized?.observe(host);
    again();
    return () => { seen?.disconnect(); sized?.disconnect(); };
  }

  root.DgcCard = Object.freeze({ html, node, chips, toggle, click, key, fit, watch, icon, esc, ICONS });
})();
