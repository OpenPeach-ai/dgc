// "What's new in 0.52" (pips-flow-design §3.3, item 1): a dialog in the side bar the first time 0.52's side bar is
// shown. A 16:9 picture drawn here in the page's own look (no image file), the feature's name and its short text,
// dots, Skip / Next (the last slide: Done), the arrow keys. Skip, Done and Esc close it for good: the page says
// {type: "whatsNewSeen"} and the editor remembers (src/whatsNew.ts). A click on the page behind does not answer for you.
//
// A classic script, loaded before the side bar's own (window.DgcWhatsNew). It draws into #whats-new (src/panel.ts);
// the look is media/shared/whatsnew.css. Everything is built with textContent: no markup is ever taken from a message.
(function () {
  "use strict";
  const root = typeof window !== "undefined" ? window : globalThis;
  if (root.DgcWhatsNew) return;

  // Slide 6 is a list, so a line that didn't ship isn't shown. `ships: false` lines wait for their feature
  // (alsoNew(["browser"]) shows one that has shipped).
  const ALSO = [
    { id: "settings", text: "Change settings by asking." },
    { id: "fallback", text: "A fallback model on every surface." },
    { id: "browser", text: "Your Browser, where you sign in once for your Pips.", ships: false },
    { id: "payments", text: "Daily payment limits in dollars." },
    { id: "incognito", text: "Incognito chats." },
  ];
  function alsoNew(shipped) {
    const extra = Array.isArray(shipped) ? shipped : [];
    return ALSO.filter((line) => line.ships !== false || extra.includes(line.id)).map((line) => line.text).join(" ");
  }
  /** The six slides: its picture, its name, its text and (slide 1) a quieter last line. */
  function slides(shipped) {
    return [
      { scene: "pips-list", title: "Pips are one kind now",
        text: "No more Personal and Project Pips. One list, one New Pip. Every Pip has its own chat, its own computer, and, if you give it a folder, its own copy of that folder to work in.",
        more: "A Pip tells you what it finds in its own chat. What needs you is on Home." },
      { scene: "wall", title: "Each Pip works behind a wall",
        text: "Inside its own computer a Pip never asks. Only what crosses the wall does: changing your folder, sending, posting, paying. You choose how much it asks: Ask me first, Approve for me, or Do it all." },
      { scene: "levels", title: "Pips tell you, then fix",
        text: "When a check finds something, the Pip says what is wrong and why, fixes it in its own copy, and shows you the change to apply. What only you can do is said once and kept in one place." },
      { scene: "cards", title: "Home is yours",
        text: "Home is now cards: Needs you, Recent, Running now, Token usage and more. Add, remove and arrange them with Cards; they change shape with the width." },
      { scene: "work", title: "Work, tidier",
        text: "Archive and restore sessions. A goal now runs as turns you can follow. Type @ and a Pip's name to hand it a job; its answer comes back to that session." },
      { scene: "settings", title: "Also new", text: alsoNew(shipped) },
    ];
  }

  // ---- the pictures: small scenes of the real screens, in the page's own tokens -----------------------------------
  const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
  const box = (cls, ...kids) => { const n = el("div", cls); for (const k of kids) if (k) n.append(k); return n; };
  const face = (tone) => { const f = el("span", "wn-face"); f.dataset.tone = tone; f.append(el("i"), el("i")); return f; };
  const pip = (tone, name, extra) => box("wn-row", face(tone), el("span", "wn-name", name), extra || null);
  const line = (text, cls) => el("span", "wn-line" + (cls ? " " + cls : ""), text);
  const chip = (text, cls) => el("span", "wn-chip" + (cls ? " " + cls : ""), text);
  const file = (name) => box("wn-file", el("i", "wn-file-mark"), el("span", "wn-file-name", name));

  const SCENES = {
    // One list of Pips; beyond the wall, what each has of its own.
    "pips-list": () => [
      box("wn-panel wn-list", pip("violet", "Core", el("span", "wn-star", "★")), pip("green", "GST watchdog"), pip("rose", "ERP daily audit"), pip("blue", "Mornings")),
      el("span", "wn-wall"),
      box("wn-panel wn-own", pip("green", "GST watchdog"), line("its own chat"), line("its own computer"), line("its own copy of your folder")),
    ],
    // Your folder, copied into the Pip's walled box; only what crosses the wall asks.
    wall: () => [
      box("wn-panel wn-folder", el("span", "wn-cap", "Your folder"), file("orders.py"), file("gst/rules.py"), file("README.md")),
      box("wn-cross", el("span", "wn-arrow", "copy"), el("span", "wn-arrow back", "asks")),
      box("wn-panel wn-boxed", el("span", "wn-cap", "The Pip's computer"), file("orders.py"), file("gst/rules.py"), file("README.md")),
    ],
    // The level, and a Pip saying what it found, fixed and applied.
    levels: () => [
      box("wn-levels", chip("Ask me first"), chip("Approve for me", "on"), chip("Do it all")),
      box("wn-panel wn-says", pip("green", "GST watchdog"), line("Found: March totals round down.", "strong"), line("Fixed in my copy, and applied to your folder."),
        box("wn-says-foot", el("span", "wn-diff", "+4 −2"), chip("Review"), chip("Undo"))),
    ],
    // Home as cards: a small bento.
    cards: () => [
      box("wn-bento",
        box("wn-panel wn-card wide", el("span", "wn-cap", "Needs you"), line("Allow npm test?", "strong"), line("A reply to send")),
        box("wn-panel wn-card", el("span", "wn-cap", "Running now"), box("wn-run", el("i", "wn-pulse"), line("Nightly audit"))),
        box("wn-panel wn-card", el("span", "wn-cap", "Recent"), line("Totals fixed"), line("Trip costs")),
        box("wn-panel wn-card wide", el("span", "wn-cap", "Token usage"), box("wn-bars", ...[38, 62, 45, 80, 56, 30, 70, 48, 90, 60].map((h) => { const b = el("i"); b.style.height = h + "%"; return b; })))),
    ],
    // Work's sessions, with Archive; a Pip handed a job from a session.
    work: () => [
      box("wn-panel wn-sessions", el("span", "wn-cap", "Work"),
        box("wn-session", el("i", "wn-voxel"), el("span", "wn-name", "Fix the login redirect"), chip("Archive")),
        box("wn-session", el("i", "wn-voxel b"), el("span", "wn-name", "Invoice totals"), el("span", "wn-age", "2h")),
        box("wn-session quiet", el("i", "wn-voxel c"), el("span", "wn-name", "Archived (3)"), chip("Restore"))),
      box("wn-panel wn-ask", box("wn-typed", el("span", "wn-at", "@GST watchdog"), el("span", "wn-typed-rest", "check March"))),
    ],
    // A setting changed by asking: the line it leaves, with Undo.
    settings: () => [
      box("wn-panel wn-asked", el("span", "wn-bubble", "Use 8 Pip runs at once"),
        box("wn-change", el("i", "wn-tick"), box("wn-change-words", line("Changed Pip runs at once", "strong"), line("4 → 8")), chip("Undo"))),
      box("wn-also", chip("Fallback model"), chip("Incognito")),
    ],
  };

  // ---- the dialog ---------------------------------------------------------------------------------------------------
  function mount(layer, { onSeen, release = "0.52" } = {}) {
    let list = slides(), at = 0, back = null;
    const dialog = box("wn-dialog dgc-dialog");
    const picture = el("div", "wn-picture"); picture.setAttribute("aria-hidden", "true");
    const kicker = el("p", "wn-kicker"), title = el("h2", "wn-title"), text = el("p", "wn-text");
    title.id = "wn-title";
    const dots = el("div", "wn-dots"); dots.setAttribute("role", "group"); dots.setAttribute("aria-label", "Slides");
    const step = el("span", "wn-step sr-only"); step.setAttribute("aria-live", "polite");
    const skip = el("button", "wn-skip dgc-btn", "Skip"), next = el("button", "wn-next dgc-btn primary", "Next");
    skip.type = next.type = "button";
    const actions = box("wn-actions", skip, next);
    dialog.append(picture, box("wn-body", kicker, title, text, box("wn-foot", dots, step, actions)));
    layer.replaceChildren(dialog);
    layer.setAttribute("aria-labelledby", "wn-title");

    const words = (slide) => text.replaceChildren(document.createTextNode(slide.text), ...(slide.more ? [document.createTextNode(" "), el("span", "wn-more", slide.more)] : []));
    // Every slide's text gets the room of the longest one at this width, so Skip and Next never move under the pointer.
    function level() {
      text.style.minHeight = "";
      let most = 0;
      for (const slide of list) { words(slide); most = Math.max(most, text.offsetHeight); }
      if (most > 0) text.style.minHeight = most + "px";
      words(list[at]);
    }
    function paint() {
      const slide = list[at], last = at === list.length - 1;
      picture.dataset.scene = slide.scene;
      picture.replaceChildren(box("wn-scene wn-scene-" + slide.scene, ...(SCENES[slide.scene] ? SCENES[slide.scene]() : [])));
      kicker.textContent = `What's new in DGC ${release}`;
      title.textContent = slide.title;
      words(slide);
      dots.replaceChildren(...list.map((s, i) => { const d = el("button", "wn-dot" + (i === at ? " on" : "")); d.type = "button"; d.dataset.at = String(i);
        d.setAttribute("aria-label", `Slide ${i + 1} of ${list.length}: ${s.title}`); if (i === at) d.setAttribute("aria-current", "step"); return d; }));
      step.textContent = `${at + 1} of ${list.length}`;
      skip.hidden = last;
      next.textContent = last ? "Done" : "Next";
    }
    function go(to) { const clamped = Math.max(0, Math.min(list.length - 1, to)); if (clamped === at) return; at = clamped; paint(); }
    function close(seen) {
      if (layer.hidden) return;
      layer.hidden = true;
      document.removeEventListener("keydown", keys, true);
      root.removeEventListener("resize", level);
      if (seen && typeof onSeen === "function") onSeen();
      try { if (back && back.isConnected) back.focus(); } catch { /* the page's own focus */ }
      back = null;
    }
    function keys(e) {
      if (layer.hidden) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); return; }
      if (e.key === "ArrowRight" || e.key === "ArrowLeft") { e.preventDefault(); e.stopPropagation(); go(at + (e.key === "ArrowRight" ? 1 : -1)); return; }
      if (e.key === "Tab") {
        // The keyboard stays in the dialog while it is open.
        const stops = [...layer.querySelectorAll("button")].filter((b) => !b.hidden && !b.disabled);
        const here = stops.indexOf(document.activeElement);
        e.preventDefault(); e.stopPropagation();
        const to = here < 0 ? (e.shiftKey ? stops.length - 1 : 0) : (here + (e.shiftKey ? -1 : 1) + stops.length) % stops.length;
        stops[to]?.focus();
      }
    }
    dots.addEventListener("click", (e) => { const d = e.target.closest?.(".wn-dot"); if (d) { go(Number(d.dataset.at)); dots.querySelector(".wn-dot.on")?.focus(); } });
    skip.addEventListener("click", () => close(true));
    next.addEventListener("click", () => { if (at === list.length - 1) close(true); else { go(at + 1); next.focus(); } });

    return {
      /** Opens it on the first slide. `shipped`: the "Also new" lines that have shipped since (ids). */
      open(options = {}) {
        if (typeof options.release === "string" && /^\d+\.\d+(\.\d+)?$/.test(options.release)) release = options.release;
        list = slides(options.shipped); at = 0;
        if (layer.hidden) back = document.activeElement;
        paint();
        layer.hidden = false;
        level();
        root.removeEventListener("resize", level);
        root.addEventListener("resize", level);
        document.removeEventListener("keydown", keys, true);
        document.addEventListener("keydown", keys, true);
        next.focus({ preventScroll: true });
      },
      close, isOpen: () => !layer.hidden,
    };
  }

  root.DgcWhatsNew = { mount, slides, alsoNew };
})();
