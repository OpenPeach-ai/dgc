// A card's answers as a row of small icon buttons that turn into the full button (asked 12 Nov): at rest a tick, a
// cross, an eye, an arrow or a double tick, the main answer filled. Pointed at, or reached by Tab, the one answer
// shows as a pill with its icon and its word: the pill grows from that icon's own box to cover the row, held at the
// row's right edge (wider than the row when the word is, growing to the left), and the other icons slide toward it and
// shrink away under it. Moving along the row turns the pill into the next answer; leaving shrinks it back into its
// icon. Used by Home's cards (media/shared/hub.js) and the Pips page's Needs attention (src/pipAttention.js); a card
// inside a Work session, a chat or a Pip's chat keeps its full buttons. media/shared/iconactions.css is how it looks.
// The row is drawn from data, by the page that draws the card: html() is its markup, and watch() answers the pointer
// and the keyboard for every row under a host, whenever it is drawn again. Each button's box stays where it is (it is
// what the pointer finds): only the icon inside it moves. A classic script, loaded before the page's own, and imported
// by the Pips bundle: window.DgcIconActions.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcIconActions) return;

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const ICONS = {
    check: '<path d="M3.2 8.6l3.1 3.1 6.5-7.4"/>',
    x: '<path d="M4.3 4.3l7.4 7.4M11.7 4.3l-7.4 7.4"/>',
    eye: '<path d="M1.6 8s2.4-4.4 6.4-4.4S14.4 8 14.4 8s-2.4 4.4-6.4 4.4S1.6 8 1.6 8z"/><circle cx="8" cy="8" r="1.9"/>',
    open: '<path d="M5.2 10.8l5.6-5.6M6.4 5.2h4.4v4.4"/>',
    read: '<path d="M1.6 8.7l2.8 2.8 5.8-6.6M7.4 11.1l.4.4 5.8-6.6"/>',
  };
  const svg = (name) => `<svg class="dgc-ia-ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICONS[name] || ICONS.check}</svg>`;
  /** The icon an answer wears when it names none: by its word. Yes is a tick, no a cross, the way to all of it an eye. */
  function iconFor(label) {
    const w = String(label || "").trim().toLowerCase();
    if (/^mark read/.test(w)) return "read";
    if (/^(not now|deny|reject|decline|no\b|dismiss|cancel|skip)/.test(w)) return "x";
    if (/^(review|details|see)/.test(w)) return "eye";
    if (/^open/.test(w)) return "open";
    return "check";
  }
  const attrsHtml = (attrs) => Object.entries(attrs || {}).filter(([, v]) => v !== undefined && v !== null && v !== false)
    .map(([k, v]) => (v === true ? ` ${esc(k)}` : ` ${esc(k)}="${esc(v)}"`)).join("");
  let serial = 0;

  /**
   * The row as HTML.
   *   actions  [{ label, icon?, primary?, title?, say?, attrs?, disabled? }]: `label` is the word the pill shows and the
   *            button's name ("Apply"); `icon` one of ICONS (by the word when left out); `primary` the one filled answer (.dgc-ia-main: a class of its own, so no page's ".primary" button rule reaches it);
   *            `title` the longer line, kept as the button's description (never a tooltip: the pill says the word);
   *            `say` a spoken name in place of the word; `attrs` the page's own (what a click means is the page's).
   *   label    the row's spoken name ("Answers")
   * Every string is escaped here.
   */
  function html(actions, { label = "Answers", cls = "" } = {}) {
    const list = (actions || []).filter(Boolean);
    if (!list.length) return "";
    let said = "";
    const buttons = list.map((a) => {
      const icon = ICONS[a.icon] ? a.icon : iconFor(a.label), id = a.title ? `dgc-ia-d${++serial}` : "";
      if (id) said += `<span class="dgc-ia-said" id="${id}" hidden>${esc(a.title)}</span>`;
      return `<button type="button" class="dgc-ia-btn${a.primary ? " dgc-ia-main" : ""}" data-ia-icon="${icon}"${attrsHtml(a.attrs)}${a.say ? ` aria-label="${esc(a.say)}"` : ""}${id ? ` aria-describedby="${id}"` : ""}${a.disabled ? " disabled" : ""}>`
        + `${svg(icon)}<span class="dgc-ia-word">${esc(a.label)}</span></button>`;
    }).join("");
    return `<div class="dgc-ia${cls ? ` ${esc(cls)}` : ""}" role="group" aria-label="${esc(label)}" data-ia-n="${list.length}">${buttons}${said}`
      + `<span class="dgc-ia-pill" aria-hidden="true"><svg class="dgc-ia-ico" viewBox="0 0 16 16" aria-hidden="true" focusable="false"></svg><span class="dgc-ia-pill-word"></span></span></div>`;
  }

  const rows = new WeakMap();        // a row → what is shown in it: { hot, anim }
  const GROW = "cubic-bezier(.2,.8,.2,1)";
  const still = (view) => !view.matchMedia || view.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const buttonsOf = (row) => [...row.querySelectorAll(".dgc-ia-btn")];

  /** One answer shown as the pill. `kbd`: reached by the keyboard (the ring sits on the pill); `at once`: no motion. */
  function show(row, button, kbd, atOnce = false) {
    const pill = row.querySelector(".dgc-ia-pill"), view = row.ownerDocument.defaultView;
    if (!pill || button.disabled) return;
    const state = rows.get(row) || {}, was = state.hot && row.classList.contains("dgc-ia-on") ? state.hot : null;
    row.classList.toggle("dgc-ia-kbd", !!kbd);
    if (was === button) return;
    // On a Home card the words stand beside the row, and a pill wider than the row grew to the left over the end of
    // their lines (13 Nov). There the row takes the widest answer's room while a pill is up, so the words wrap or end
    // before it; at rest it is the icons' own width again (the words have the room back). Its boxes keep their place:
    // the row grows to the left.
    if (!was && row.closest(".dgc-hub-card")) {
      const word = pill.querySelector(".dgc-ia-pill-word"), kept = word.textContent;
      row.style.minWidth = ""; pill.style.left = "auto"; pill.style.width = "auto";
      let most = 0;
      for (const b of buttonsOf(row)) { word.textContent = b.querySelector(".dgc-ia-word")?.textContent || ""; most = Math.max(most, Math.ceil(pill.getBoundingClientRect().width)); }
      word.textContent = kept;
      view.clearTimeout(state.rest); state.rest = 0;
      if (most > row.offsetWidth) row.style.minWidth = `${most}px`;
    }
    const from = was ? { left: `${pill.offsetLeft}px`, width: `${pill.offsetWidth}px` } : { left: `${button.offsetLeft}px`, width: `${button.offsetWidth}px` };
    for (const b of buttonsOf(row)) {
      b.classList.toggle("dgc-ia-hot", b === button);
      b.style.setProperty("--ia-toward", `${Math.round((button.offsetLeft - b.offsetLeft) * 0.6)}px`);
    }
    state.anim?.cancel(); state.anim = null; state.hot = button;      // (a running move would answer for the pill's size below)
    pill.querySelector("svg").innerHTML = ICONS[button.dataset.iaIcon] || ICONS.check;
    pill.querySelector(".dgc-ia-pill-word").textContent = button.querySelector(".dgc-ia-word")?.textContent || "";
    pill.classList.toggle("dgc-ia-main", button.classList.contains("dgc-ia-main"));
    // As wide as the row; wider when the word is, growing to the left from the row's right edge.
    pill.style.left = "auto"; pill.style.width = "auto";
    const wide = Math.max(row.offsetWidth, Math.ceil(pill.getBoundingClientRect().width));
    const to = { left: `${row.offsetWidth - wide}px`, width: `${wide}px` };
    pill.style.left = to.left; pill.style.width = to.width;
    row.classList.add("dgc-ia-on");
    if (!atOnce && !still(view) && pill.animate) {
      state.anim = pill.animate([from, to], { duration: was ? 150 : 230, easing: GROW });
      if (was) pill.querySelector(".dgc-ia-pill-word").animate?.([{ opacity: 0, transform: "translateY(3px)" }, { opacity: 1, transform: "none" }], { duration: 160, easing: "ease-out" });
    }
    rows.set(row, state);
  }
  /** Back to the icons: the pill shrinks into the one it came from. */
  function hide(row, atOnce = false) {
    const state = rows.get(row), pill = row.querySelector(".dgc-ia-pill"), view = row.ownerDocument.defaultView;
    if (!state?.hot || !pill) { row.classList.remove("dgc-ia-on", "dgc-ia-kbd"); return; }
    const button = state.hot, from = { left: `${pill.offsetLeft}px`, width: `${pill.offsetWidth}px`, opacity: 1 };
    state.hot = null; state.anim?.cancel(); state.anim = null;
    if (!atOnce && !still(view) && pill.animate && button.isConnected) {
      state.anim = pill.animate([from, { left: `${button.offsetLeft}px`, width: `${button.offsetWidth}px`, opacity: 0 }], { duration: 180, easing: "cubic-bezier(.4,0,.2,1)" });
    }
    row.classList.remove("dgc-ia-on", "dgc-ia-kbd");
    for (const b of buttonsOf(row)) b.classList.remove("dgc-ia-hot");
    // The words have their room back once the pill has gone into its icon.
    if (row.style.minWidth) { view.clearTimeout(state.rest); const back = () => { state.rest = 0; if (!row.classList.contains("dgc-ia-on")) row.style.minWidth = ""; }; if (state.anim) state.rest = view.setTimeout(back, 190); else back(); }
  }
  const focusShown = (node) => { try { return node.matches(":focus-visible"); } catch { return true; } };
  /** The keyboard's own answer in this row, when it is on one and shows a ring. */
  const keyed = (row) => { const a = (row.getRootNode?.() || row.ownerDocument).activeElement; return a && row.contains(a) && a.classList.contains("dgc-ia-btn") && focusShown(a) ? a : null; };

  /**
   * Answers the pointer and the keyboard for every row under `host` (an element or a shadow root), now and whenever its
   * cards are drawn again: nothing is wired to a row itself. A finger's tap is a click and shows no pill. Returns a
   * function that stops.
   */
  function watch(host) {
    if (!host || !host.addEventListener) return () => {};
    const rowOf = (target) => target?.closest?.(".dgc-ia"), buttonOf = (target) => target?.closest?.(".dgc-ia-btn");
    const over = (e) => { if (e.pointerType === "touch") return; const b = buttonOf(e.target); if (b && !b.disabled) show(rowOf(b), b, false); };
    const out = (e) => {
      const row = rowOf(e.target);
      if (!row || (e.relatedTarget && row.contains(e.relatedTarget))) return;
      // The pointer left: the keyboard's answer shows again when it has one here, or the row rests.
      const k = keyed(row);
      if (k) show(row, k, true); else hide(row);
    };
    const focus = (e) => { const b = buttonOf(e.target); if (b && focusShown(b)) show(rowOf(b), b, true); };
    const blur = (e) => {
      const row = rowOf(e.target);
      if (!row || (e.relatedTarget && row.contains(e.relatedTarget))) return;
      let pointed = null; try { pointed = row.querySelector(".dgc-ia-btn:hover"); } catch { pointed = null; }
      if (pointed) show(row, pointed, false); else hide(row);
    };
    host.addEventListener("pointerover", over); host.addEventListener("pointerout", out);
    host.addEventListener("focusin", focus); host.addEventListener("focusout", blur);
    return () => { host.removeEventListener("pointerover", over); host.removeEventListener("pointerout", out); host.removeEventListener("focusin", focus); host.removeEventListener("focusout", blur); };
  }

  /** After the cards under `within` were drawn again: a row the keyboard or the pointer is still on shows its pill at
      once, with no motion (it was showing before the redraw). */
  function refresh(within) {
    if (!within?.querySelectorAll) return;
    for (const row of within.querySelectorAll(".dgc-ia:not(.dgc-ia-on)")) {
      const k = keyed(row);
      let pointed = null; try { pointed = row.querySelector(".dgc-ia-btn:hover"); } catch { pointed = null; }
      if (k) show(row, k, true, true); else if (pointed) show(row, pointed, false, true);
    }
  }

  root.DgcIconActions = Object.freeze({ html, watch, refresh, show, hide, iconFor, ICONS });
})();
