// The four marks, the maintainer's own designs, and which of their twelve palettes each thing wears:
//   Mote (media/shared/mote.css)     a ChatDGC chat        span.mote.mote--<palette> > i*3
//   Voxel (media/shared/voxel.css)   a Work session        span.voxel.voxel--<palette> > i*6
//   Folio (media/shared/folio.css)   a widget              span.folio.folio--<palette> > i*3
//   Portal (media/shared/portal.css) one of a Pip's computers  span.portal.portal--<palette> > i*2
//   Pinwheel (media/shared/pinwheel.css) a ChatDGC project (13 Nov)  span.pinwheel.pinwheel--<palette> > i*4
//     (only a project a user makes in ChatDGC: a Work session's folder is a directory, and keeps its plain folder icon)
// The stylesheets are the maintainer's, as written; they also hold Citron and Lime, which are too bright and never used here.
// A session, a chat or a widget keeps the palette it was given (src/dock.ts stores it on this computer); a computer's
// palette follows its number, as the picture on its desktop does. Nothing here touches a page: the pages (window.DgcMarks) and the
// extension's host (src/dock.ts, src/pipsView.ts) run the same code, so both give the same thing the same palette.
(function (root, make) {
  const api = make();
  if (typeof module === "object" && module && module.exports) module.exports = api;
  if (root && !root.DgcMarks) root.DgcMarks = api;
})(typeof window !== "undefined" ? window : null, function () {
  "use strict";
  /** The twelve, in the order they are offered. (The maintainer's sheets have fourteen: never citron, never lime.) */
  const PALETTES = Object.freeze(["ember", "peach", "saffron", "fern", "mint", "lagoon", "ice", "azure", "iris", "lilac", "orchid", "rose"]);
  /** Each palette's hue, as the maintainer's sheets set it (--h). */
  const HUES = Object.freeze({ ember: 3, peach: 22, saffron: 39, fern: 133, mint: 158, lagoon: 177, ice: 195, azure: 213, iris: 247, lilac: 273, orchid: 294, rose: 331 });
  /** A mark's set, and how many empty <i> it holds. */
  const SETS = Object.freeze({ mote: 3, voxel: 6, folio: 3, portal: 2, pinwheel: 4 });
  /** What wears which set. */
  const SET_OF = Object.freeze({ chat: "mote", work: "voxel", widget: "folio", computer: "portal", project: "pinwheel" });
  const isPalette = (name) => typeof name === "string" && PALETTES.includes(name);
  /** A palette's name as it is said: "Lagoon". */
  const label = (name) => (isPalette(name) ? name[0].toUpperCase() + name.slice(1) : "");

  // ---- the colours from before the marks: seven pairs, by number ------------------------------------------------------
  // A session made before the marks had one of seven colour pairs: the one its owner chose, or the one its id gave
  // (2 to 7). It keeps the palette nearest in hue to its pair's first colour: purple #a855f7 (271) is Lilac (273),
  // blue #3b82f6 (217) Azure (213), cyan #22d3ee (188) Ice (195), green #4ade80 (142) Fern (133), yellow #facc15 (48)
  // Saffron (39), orange #fb923c (27) Peach (22), red #ef4444 (0) Ember (3).
  const OLD = Object.freeze(["", "lilac", "azure", "ice", "fern", "saffron", "peach", "ember"]);
  const hash = (text) => { let h = 2166136261; for (const ch of String(text || "")) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
  /** The pair an id had by itself before the marks: one of 2 to 7, the same every time. */
  const oldPair = (id) => 2 + (hash(id) % 6);
  /** The palette for one of the seven old pairs; "" when it isn't one. */
  const fromOld = (pair) => OLD[Number.isInteger(pair) && pair >= 1 && pair <= 7 ? pair : 0];
  /** What a thing wears before it has been given a palette (the host has not said yet, or keeps nothing): from its id
   *  alone, the same every time. A session or a chat: its old colour's palette. Anything else: one of the twelve. */
  const fallback = (kind, id) => (kind === "work" || kind === "chat" ? fromOld(oldPair(id)) : PALETTES[hash(id) % PALETTES.length]);

  // ---- giving out palettes ---------------------------------------------------------------------------------------------
  /** The first of the twelve that none of `around` wears. `around`: palettes, the nearest first; past eleven different
   *  ones the farthest no longer count, so there is always one to give. */
  function pick(around) {
    const used = new Set();
    for (const name of around || []) { if (used.size >= PALETTES.length - 1) break; if (isPalette(name)) used.add(name); }
    return PALETTES.find((name) => !used.has(name)) || PALETTES[0];
  }
  /** When a session was made, in ms: a Work session's id starts with its date and time ("20261106-101500-a1"); else
   *  whatever date it carries. NaN when nothing says. */
  function born(id, stamp) {
    const m = /^(\d{4})(\d\d)(\d\d)-(\d\d)(\d\d)(\d\d)/.exec(String(id || ""));
    if (m) { const at = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime(); if (Number.isFinite(at)) return at; }
    if (typeof stamp === "number") return stamp;
    const text = String(stamp || ""), local = /^(\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d)$/.exec(text);
    return local ? new Date(+local[1], +local[2] - 1, +local[3], +local[4], +local[5]).getTime() : Date.parse(text);
  }
  /**
   * Palettes for the things of one kind that have none yet. The same answer for the same question, wherever it is asked.
   *   kind:   "work" | "chat" | "widget"
   *   list:   [{ id, born }] the things in view, in the order their list shows them (one alone: a session's own tab)
   *   known:  { "<kind>:<id>": palette } what has been given already, the oldest first
   *   since:  when the marks arrived on this computer (ms). A session or chat made before then keeps its old colour's
   *           palette; one made after (or with no date) is new.
   * A new thing gets the first palette not worn by the things around it: its list's other rows, the nearest first,
   * and after them the ones given a palette most recently. Returns { key: palette } for the ones that had none.
   */
  function assign({ kind, list, known, since }) {
    const out = {}, rows = (Array.isArray(list) ? list : []).filter((row) => row && typeof row.id === "string" && row.id);
    const has = (id) => { const key = `${kind}:${id}`; return isPalette(known?.[key]) ? known[key] : out[key] || ""; };
    const recent = Object.keys(known || {}).filter((key) => key.startsWith(`${kind}:`) && isPalette(known[key])).reverse();
    const old = kind === "work" || kind === "chat";
    rows.forEach((row, at) => {
      if (has(row.id)) return;
      const key = `${kind}:${row.id}`;
      if (old && Number.isFinite(row.born) && Number.isFinite(since) && row.born < since) { out[key] = fromOld(oldPair(row.id)); return; }
      const around = [];
      for (let d = 1; d < rows.length; d++) for (const near of [rows[at - d], rows[at + d]]) if (near) { const worn = has(near.id); if (worn) around.push(worn); }
      for (const other of recent) if (other !== key) around.push(known[other]);
      out[key] = pick(around);
    });
    return out;
  }

  // ---- a computer's palette: by its number, matching the picture on its desktop ---------------------------------------
  // Computer 1's desktop is Dusk (violet), 2's Aurora (teal), 3's Daylight (lavender); Dev Mode allows more.
  const COMPUTERS = Object.freeze(["iris", "lagoon", "lilac", "azure", "rose", "mint", "saffron", "orchid", "ice", "peach", "fern", "ember"]);
  /** The palette of a Pip's computer number `n` (1, 2, 3...): the twelve in the computers' own order, round again. */
  const computerPalette = (n) => COMPUTERS[((Number.isSafeInteger(n) && n >= 1 ? n : 1) - 1) % COMPUTERS.length];

  // ---- a mark as HTML --------------------------------------------------------------------------------------------------
  const phase = (id) => hash(id) % 8;
  /**
   * A mark, in the sheet's own markup. `set`: "mote" | "voxel" | "folio" | "portal". `palette`: one of the twelve (anything else
   * draws Lagoon... never citron or lime). `size` in px (or let the page's CSS say). `moving`: it is the one that moves;
   * every other mark is paused, at rest. `id` only offsets where its motion starts, so two side by side never move in
   * step. `name`: said to a screen reader when the mark stands alone; without it the mark is decoration.
   */
  function html(set, palette, { size, moving = false, id = "", name = "" } = {}) {
    const kind = Object.prototype.hasOwnProperty.call(SETS, set) ? set : "mote", worn = isPalette(palette) ? palette : "lagoon";
    const style = [size ? `--size:${Number(size)}px` : "", moving ? `--phase:-${phase(id)}s` : `--${kind}-play:paused`].filter(Boolean).join(";");
    const said = name ? ` role="img" aria-label="${String(name).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]))}"` : ' aria-hidden="true"';
    return `<span class="${kind} ${kind}--${worn}" data-mark="${kind}" data-palette="${worn}"${moving ? " data-moving" : ""} style="${style}"${said}>${"<i></i>".repeat(SETS[kind])}</span>`;
  }
  /** A session's, a chat's or a widget's mark: `kind` "work" | "chat" | "widget" | "computer". */
  const of = (kind, palette, more) => html(SET_OF[kind] || "mote", palette, more);

  // ---- a page's own account of who wears what ------------------------------------------------------------------------
  /**
   * For a page: what the host keeps, what was given here since, and the asking. `post(message)` sends to the host.
   *   said(msg)             the host's "dock" message: the palettes it keeps, and when the marks arrived
   *   heard()               the host has said what it keeps (until then a mark wears what its id alone gives, and
   *                         nothing is asked)
   *   palette(kind, id)     what the thing wears now
   *   wear(kind, list)      the things in view, in their list's order ([{ id, born }]): each without a palette is given
   *                         one, and the host is asked to keep it ("dockPalettes"). The host runs `assign` on the same
   *                         question, so its answer is this one.
   *   mark(kind, id, more)  its mark as HTML. One drawn outside a list is given its palette here: its neighbours are
   *                         the ones given a palette most recently.
   */
  function keeper(post) {
    let colours = {}, since = 0, heard = false;
    const given = {}, asked = new Set();
    const has = (key) => isPalette(colours[key]);
    const mine = {
      heard: () => heard,
      said(msg) {
        colours = msg && msg.colours && typeof msg.colours === "object" ? msg.colours : {}; since = Number(msg && msg.since) || 0; heard = true;
        // What the host keeps is the answer: a palette given here meanwhile gives way to it.
        for (const key of Object.keys(given)) if (has(key)) delete given[key];
      },
      palette(kind, id) { const key = `${kind}:${id}`; return has(key) ? colours[key] : given[key] || fallback(kind, id); },
      wear(kind, list) {
        const rows = (Array.isArray(list) ? list : []).filter((row) => row && typeof row.id === "string" && row.id);
        if (!heard || !rows.length) return;
        const fresh = assign({ kind, list: rows, known: { ...colours, ...given }, since });
        const keys = Object.keys(fresh).filter((key) => !asked.has(key));
        Object.assign(given, fresh);
        if (!keys.length) return;
        for (const key of keys) asked.add(key);
        // (Asked once this drawing is done: the answer redraws the page, and must not arrive halfway through a list.)
        const ask = { type: "dockPalettes", kind, list: rows.slice(0, 200).map((row) => ({ id: row.id, ...(Number.isFinite(row.born) ? { born: row.born } : {}) })) };
        Promise.resolve().then(() => post(ask));
      },
      mark(kind, id, more = {}) {
        if (heard && !has(`${kind}:${id}`) && !given[`${kind}:${id}`]) mine.wear(kind, [{ id: String(id), born: more.born }]);
        return of(kind, mine.palette(kind, id), { id, ...more });
      },
    };
    return mine;
  }

  return Object.freeze({ PALETTES, HUES, SETS, SET_OF, COMPUTERS, isPalette, label, oldPair, fromOld, fallback, pick, born, assign, computerPalette, html, of, keeper });
});
