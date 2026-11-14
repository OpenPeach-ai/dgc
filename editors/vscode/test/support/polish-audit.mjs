// The visual polish pass's measuring stick (0.52, 14 Nov): one walk of a page as it is drawn (through every shadow
// root), returning what is measurably off: text under 4.5:1, a pill, words cut, a browser's own `title` tooltip,
// a control lying under another thing, two things lying on each other, a row whose marks and words are not level,
// uneven gaps between siblings, a focus ring that is missing or cut. `audit` and `focusAudit` run in the page (pass
// them to page.evaluate). Not a *.test.mjs file.

/** Everything measurable at rest. `opts`: { scope: a selector to stay under (the whole page by default), touch: the
 *  page is a touch screen (controls that only a pointer's hover shows are then listed) }. */
export const audit = (opts = {}) => {
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
  const roots = () => { const list = [document]; const walk = (root) => { for (const n of root.querySelectorAll("*")) if (n.shadowRoot) { list.push(n.shadowRoot); walk(n.shadowRoot); } }; walk(document); return list; };
  const ROOTS = roots();
  const all = (sel) => ROOTS.flatMap((r) => [...r.querySelectorAll(sel)]);
  const scopeEl = opts.scope ? all(opts.scope)[0] : null;
  const within = (n) => { if (!opts.scope) return true; for (let p = n; p; p = up(p)) if (p === scopeEl) return true; return false; };
  const composedContains = (a, b) => { for (let p = b; p; p = up(p)) if (p === a) return true; return false; };
  const parse = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return String(c).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const groundOf = (e) => { const layers = []; let image = false;
    for (let n = e; n; n = up(n)) { const s = getComputedStyle(n), c = parse(s.backgroundColor); if (s.backgroundImage !== "none" && !image && c[3] < 1) image = n !== e || true; if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return { g: layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]), image }; };
  const opacityOf = (e) => { let a = 1; for (let n = e; n; n = up(n)) a *= Number(getComputedStyle(n).opacity); return a; };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratioOf = (ink, e) => { const { g, image } = groundOf(e), raw = parse(ink), c = over([raw[0], raw[1], raw[2], raw[3] * opacityOf(e)], g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p);
    return { ratio: Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100, ink: c.slice(0, 3).map(Math.round).join(","), ground: g.slice(0, 3).map(Math.round).join(","), image }; };
  const one = (n) => `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\s+/).slice(0, 3).join(".") : ""}`;
  const name = (e) => { const p = up(e); return p && p !== document.body ? `${one(p)} > ${one(e)}` : one(e); };
  const words = (e) => (e.getAttribute?.("aria-label") || e.textContent || e.placeholder || e.value || "").trim().replace(/\s+/g, " ").slice(0, 48);
  const shown = (n) => n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && opacityOf(n) > 0.05;
  const R = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height });
  const round = (v) => Math.round(v * 10) / 10;
  /** What of `rect` is left after every clipping parent has cut it (null: nothing). */
  const visible = (node, rect, self = false) => { let { l, t, r, b } = R(rect);
    for (let p = self ? node : up(node); p; p = up(p)) { const s = getComputedStyle(p); if (s.overflowX === "visible" && s.overflowY === "visible") continue; const q = p.getBoundingClientRect();
      if (s.overflowX !== "visible") { l = Math.max(l, q.left); r = Math.min(r, q.right); } if (s.overflowY !== "visible") { t = Math.max(t, q.top); b = Math.min(b, q.bottom); } }
    l = Math.max(l, 0); t = Math.max(t, 0); r = Math.min(r, innerWidth); b = Math.min(b, innerHeight);
    return r - l > 0.5 && b - t > 0.5 ? { l, t, r, b, w: r - l, h: b - t } : null; };
  /** The layer a thing is drawn in: the dock, a menu, a dialog, a bar that stays while the page scrolls (or the page). */
  const layerOf = (n) => { for (let p = n; p; p = up(p)) { if (p.matches?.("dialog, [role='dialog'], [role='menu'], [role='listbox'], [role='tooltip'], .dgc-pop, .dgc-popover, #dgc-dock, #hover-tip, #side-tabs, .pip-to-latest, .to-latest, #scroll-latest")) return p; const pos = getComputedStyle(p).position; if (pos === "fixed" || pos === "sticky") return p; } return null; };
  const deepHit = (x, y) => { let e = document.elementFromPoint(x, y); while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(x, y); if (!inner || inner === e) break; e = inner; } return e; };
  const CONTROL = "button, input:not([type='hidden']), select, textarea, [role='button'], [role='tab'], [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='option'], [role='combobox'], [role='switch'], [role='checkbox'], summary, a[href], [contenteditable='true'], [tabindex='0']";
  const out = { width: innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth + 1 ? document.documentElement.scrollWidth - innerWidth : 0,
    contrast: [], pills: [], cut: [], titles: [], covered: [], overlap: [], level: [], gaps: [], unseen: [], small: [], offscreen: [] };

  // ---- words: contrast, cut ------------------------------------------------------------------------------------------
  const textLeaves = [];
  for (const root of ROOTS) {
    const walk = document.createTreeWalker(root === document ? document.body : root, NodeFilter.SHOW_TEXT);
    for (let t = walk.nextNode(); t; t = walk.nextNode()) {
      const e = t.parentElement;
      if (!e || !t.textContent.trim() || ["STYLE", "SCRIPT", "TITLE", "OPTION", "NOSCRIPT", "TEMPLATE"].includes(e.tagName) || !within(e) || !shown(e)) continue;
      const s = getComputedStyle(e);
      if (s.position === "absolute" && (parseFloat(s.width) <= 1 || s.clip !== "auto" || s.clipPath !== "none")) continue;   // read aloud only
      const range = document.createRange(); range.selectNodeContents(t); const rects = [...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
      if (!rects.length) continue;
      const vis = visible(t.parentElement, rects[0], true); if (!vis) continue;
      textLeaves.push({ e, t, rect: R(rects[0]), vis, lines: rects.length, s });
    }
  }
  const seenContrast = new Set();
  for (const { e, t, s } of textLeaves) {
    const off = e.closest("[disabled], [aria-disabled='true']");
    const fill = s.webkitTextFillColor, m = ratioOf(fill && fill !== s.color ? fill : s.color, e), size = parseFloat(s.fontSize), large = size >= 24 || (size >= 18.66 && Number(s.fontWeight) >= 700);
    if (fill && /rgba\(0, 0, 0, 0\)|transparent/.test(fill)) continue;   // words painted by a moving gradient (a shimmer): no one colour to read
    if (opts.inks && new RegExp(opts.inks).test(name(e))) (out.inks = out.inks || []).push({ what: name(e), text: t.textContent.trim().slice(0, 30), ratio: m.ratio });   // (asked for: every such word's ratio, passing or not)
    if (!off && m.ratio < (large ? 3 : 4.5)) { const key = `${name(e)}|${m.ratio}`; if (!seenContrast.has(key)) { seenContrast.add(key); out.contrast.push({ what: name(e), text: t.textContent.trim().replace(/\s+/g, " ").slice(0, 40), size, ...m }); } }
  }
  for (const e of all(".codicon, svg")) {
    if (!within(e) || e.closest(".dgc-plush, [data-mark], .dgc-sheet, [disabled], [aria-disabled='true'], .mote, .voxel, .folio, .portal, .mosaic") || !shown(e)) continue;
    const r = e.getBoundingClientRect(); if (r.width < 6 || r.height < 6 || !visible(e, r)) continue;
    const s = getComputedStyle(e); if (e.tagName === "svg" && !/currentcolor/i.test(e.outerHTML)) continue;
    const m = ratioOf(s.color, e); if (m.ratio < 3) { const key = `${name(e)}|${m.ratio}`; if (!seenContrast.has(key)) { seenContrast.add(key); out.contrast.push({ what: name(e), text: "(icon)", size: Math.round(r.height), ...m }); } }
  }
  for (const e of all("textarea[placeholder], input[placeholder]")) {
    if (!within(e) || !shown(e) || e.value || e.disabled) continue;
    const m = ratioOf(getComputedStyle(e, "::placeholder").color, e); if (opts.inks && /placeholder/.test(opts.inks)) (out.inks = out.inks || []).push({ what: `${name(e)}::placeholder`, text: e.placeholder.slice(0, 30), ratio: m.ratio });
    if (m.ratio < 4.5) out.contrast.push({ what: `${name(e)}::placeholder`, text: e.placeholder.slice(0, 40), size: parseFloat(getComputedStyle(e).fontSize), ...m });
  }
  // Words cut: a box that hides what overflows it, sideways, with words wider than it.
  const cutSeen = new Set();
  for (const { e } of textLeaves) for (let n = e, k = 0; n && k < 3; n = up(n), k++) {
    const s = getComputedStyle(n); if (s.display === "inline") continue;
    if (s.overflowX === "visible" || s.overflowX === "auto" || s.overflowX === "scroll") continue;
    if (n.scrollWidth > n.clientWidth + 1 && !cutSeen.has(n)) { cutSeen.add(n); const r = n.getBoundingClientRect();
      const full = n.textContent.trim().replace(/\s+/g, " ");
      const said = [n, up(n), up(up(n) || n)].filter(Boolean).some((p) => (p.getAttribute("title") || p.getAttribute("aria-label") || p.dataset?.tip || "").includes(full.slice(0, 16)));
      out.cut.push({ what: name(n), text: full.slice(0, 60), shown: Math.round(n.clientWidth), needs: Math.round(n.scrollWidth), ellipsis: s.textOverflow === "ellipsis", said, left: Math.round(r.left), top: Math.round(r.top) }); }
    break;
  }
  // Words cut top to bottom: a single line's box shorter than its words.
  for (const { e, rect } of textLeaves) { const s = getComputedStyle(e); if (s.overflowY === "visible" || s.display === "inline") continue;
    if (e.scrollHeight > e.clientHeight + 2 && e.clientHeight < rect.h && s.overflowY !== "auto" && s.overflowY !== "scroll") out.cut.push({ what: name(e), text: words(e), shown: e.clientHeight, needs: e.scrollHeight, vertical: true }); }

  // ---- controls: pills, the browser's own tooltip, covered, small ----------------------------------------------------
  const probe = document.createElement("i"); probe.style.cssText = "position:absolute;visibility:hidden;border-radius:var(--btn-r)"; (scopeEl || document.body).append(probe);
  const family = parseFloat(getComputedStyle(probe).borderTopLeftRadius) || 6; probe.remove();
  const controls = all(CONTROL).filter(within);
  for (const node of controls) {
    if (!node.checkVisibility({ visibilityProperty: true })) continue;
    const r = node.getBoundingClientRect(), s = getComputedStyle(node);
    if (r.width < 8 || r.height < 8) continue;
    const faint = opacityOf(node) <= 0.05;
    if (faint) { if (opts.touch && s.pointerEvents !== "none" && visible(node, r)) out.unseen.push({ what: name(node), text: words(node), at: [Math.round(r.left), Math.round(r.top)] }); continue; }
    const corner = Math.max(...[s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map((v) => (v.includes("%") ? (parseFloat(v) / 100) * Math.min(r.width, r.height) : parseFloat(v)) || 0));
    const half = Math.min(r.width, r.height) / 2;
    const ROUND = ".dgc-dock-item, .dgc-dock-item *, .dgc-blob-button, [data-mark], .session-blob, .dgc-swatch, .dgc-swatch *, [role='switch'], .switch, input[type='checkbox'], input[type='radio'], input[type='range'], .csend, #send, #stop, .cd-send, .chat-send, .vb-btn, .vb-send, .info, .pip-tip-btn, .msg-choice-key";   // (one-shape-controls.test.mjs, ROUND: round on purpose)
    if (corner > family + 2.5 && corner >= half - 1.5 && !node.matches(ROUND)) out.pills.push({ what: name(node), text: words(node), size: `${Math.round(r.width)}x${Math.round(r.height)}`, corner: round(corner) });
    const vis = visible(node, r); if (!vis) continue;
    if (r.right > innerWidth + 1 || r.left < -1) out.offscreen.push({ what: name(node), text: words(node), left: round(r.left), right: round(r.right) });
    if (s.pointerEvents === "none" || node.disabled) continue;
    const cx = (vis.l + vis.r) / 2, cy = (vis.t + vis.b) / 2, hit = deepHit(cx, cy);
    if (hit && hit !== node && !composedContains(node, hit) && !composedContains(hit, node)) {
      // (A label over its own input, a control inside another control's box: not covered.)
      const label = hit.closest?.("label"); if (!(label && (label.control === node || label.contains(node)))) out.covered.push({ what: name(node), text: words(node), by: name(hit), byText: words(hit).slice(0, 30), at: [Math.round(cx), Math.round(cy)], layer: layerOf(hit) !== layerOf(node) ? one(layerOf(hit) || document.body) : "" }); }
  }
  for (const node of all("[title]").filter(within)) {
    if (!node.getAttribute("title").trim() || !shown(node)) continue; const r = node.getBoundingClientRect(); if (!visible(node, r)) continue;
    out.titles.push({ what: name(node), title: node.getAttribute("title").slice(0, 60), at: [Math.round(r.left), Math.round(r.top)], fromRight: Math.round(innerWidth - r.right), own: node.getRootNode() === document && !!document.getElementById("hover-tip") });
  }

  if (opts.quick) return out;
  // ---- things lying on things ---------------------------------------------------------------------------------------
  const atoms = [];
  for (const node of controls) { if (!shown(node)) continue; const r = node.getBoundingClientRect(); if (r.width < 4 || r.height < 4) continue; const v = visible(node, r); if (v && !node.matches("[contenteditable='true'], textarea")) atoms.push({ n: node, v, kind: "control" }); }
  for (const node of all("svg, .codicon, img, [data-mark], .dgc-plush, .dgc-sheet").filter(within)) { if (!shown(node) || node.closest("svg") !== node && node.tagName === "svg") continue; const r = node.getBoundingClientRect(); if (r.width < 4 || r.height < 4 || r.width > 64) continue; const v = visible(node, r); if (v) atoms.push({ n: node, v, kind: "mark" }); }
  for (const leaf of textLeaves) atoms.push({ n: leaf.e, v: leaf.vis, kind: "words", text: leaf.t.textContent.trim().slice(0, 30) });
  const positioned = (n) => { for (let p = n, k = 0; p && k < 4; p = up(p), k++) { const pos = getComputedStyle(p).position; if (pos === "absolute" || pos === "fixed") return true; } return false; };
  const pairSeen = new Set();
  for (let i = 0; i < atoms.length; i++) for (let j = i + 1; j < atoms.length; j++) {
    const a = atoms[i], b = atoms[j];
    const w = Math.min(a.v.r, b.v.r) - Math.max(a.v.l, b.v.l), h = Math.min(a.v.b, b.v.b) - Math.max(a.v.t, b.v.t);
    if (w < 2 || h < 2) continue;
    if (a.n === b.n || composedContains(a.n, b.n) || composedContains(b.n, a.n)) continue;
    // Two boxes of controls one over the other is a layout of its own (a tile with its small buttons); what counts is
    // words or a mark under something else, in the same layer (a menu over the page is not lying on it).
    const big = (x) => x.kind === "control" && (x.v.w > 44 || x.v.h > 44);
    if (big(a) || big(b) || (a.kind === "control" && b.kind === "control")) continue;
    if (layerOf(a.n) !== layerOf(b.n)) continue;
    // Words whose line boxes touch (one line under the next) are not lying on each other: only a real share of both counts.
    if (a.kind === "words" && b.kind === "words" && (h < 4 || w < 3)) continue;
    if (h < 3 && (a.kind === "words" || b.kind === "words")) continue;
    const key = `${name(a.n)}|${name(b.n)}`; if (pairSeen.has(key)) continue; pairSeen.add(key);
    out.overlap.push({ a: name(a.n), aText: a.text || words(a.n).slice(0, 30), b: name(b.n), bText: b.text || words(b.n).slice(0, 30), by: `${round(w)}x${round(h)}`, at: [Math.round(Math.max(a.v.l, b.v.l)), Math.round(Math.max(a.v.t, b.v.t))], floating: positioned(a.n) || positioned(b.n) });
  }

  // ---- a row's marks and words, level -------------------------------------------------------------------------------
  // In one row (a list's row, a button, a head line), two things on the same line (their heights mostly overlap) share
  // a centre: a mark with a mark within 1 px, a mark with the words beside it within 1.25 px. Words of two sizes sit on
  // one baseline, so their centres are not compared.
  const ROW = "li, button, a, summary, label, [role='option'], [role='menuitem'], [role='menuitemradio'], [role='tab'], [role='row'], [role='listitem'], [class*='row'], [class*='-line'], [class*='head'], [class*='-ch'], [class*='bar']";
  const rowOf = (n) => { for (let p = up(n), k = 0; p && k < 6; p = up(p), k++) { if (p.matches?.(ROW)) { const h = p.getBoundingClientRect().height; if (h <= 72 && h > 8) return p; } } return null; };
  const byRow = new Map(), levelSeen = new Set();
  const FACE = ".dgc-plush, [data-mark], .mote, .voxel, .folio, .portal, .dgc-sheet";   // a mark drawn of several parts: its holder is the mark
  for (const a of atoms) { if (a.kind === "control" && (a.v.w > 30 || a.v.h > 30)) continue;
    if (a.kind === "mark" && a.n.parentElement?.closest?.(FACE)) continue;
    if (a.kind === "mark" && atoms.some((x) => x.kind === "control" && x.v.w <= 30 && x.v.h <= 30 && x.n !== a.n && composedContains(x.n, a.n))) continue;
    const row = rowOf(a.n); if (!row) continue; if (!byRow.has(row)) byRow.set(row, []); byRow.get(row).push(a); }
  const mid = (v) => (v.t + v.b) / 2, said = (x) => `${one(x.n)} ${x.kind} ${round(x.v.h)}h @${round(mid(x.v))} “${(x.text || words(x.n)).slice(0, 18)}”`;
  for (const [row, list] of byRow) {
    const marks = list.filter((x) => x.kind !== "words"), lines = list.filter((x) => x.kind === "words");
    const flag = (a, b, off, what) => { const key = `${one(row)}|${one(a.n)}|${b ? one(b.n) : what}`; if (levelSeen.has(key)) return; levelSeen.add(key);
      out.level.push({ row: name(row), text: words(row).slice(0, 40), off: round(off), a: said(a), b: b ? said(b) : what, at: [Math.round(a.v.l), Math.round(a.v.t)] }); };
    // A mark with a mark on its line.
    for (let i = 0; i < marks.length; i++) for (let j = i + 1; j < marks.length; j++) { const a = marks[i], b = marks[j]; if (composedContains(a.n, b.n) || composedContains(b.n, a.n)) continue;
      const share = Math.min(a.v.b, b.v.b) - Math.max(a.v.t, b.v.t); if (share < Math.min(a.v.h, b.v.h) * 0.6 || a.v.h > 2.2 * b.v.h || b.v.h > 2.2 * a.v.h) continue;
      const off = Math.abs(mid(a.v) - mid(b.v)); if (off > 1) flag(a, b, off); }
    // A mark with the words beside it: level with their one line, or (two lines or more) with the block of them, or with its first line.
    for (const m of marks) { const beside = lines.filter((w) => !composedContains(m.n, w.n) && !composedContains(w.n, m.n) && (w.v.l >= m.v.r - 1 || w.v.r <= m.v.l + 1) && Math.min(m.v.b, w.v.b) - Math.max(m.v.t, w.v.t) > 0 && Math.abs(w.v.l >= m.v.r ? w.v.l - m.v.r : m.v.l - w.v.r) < 60);
      if (!beside.length) continue; const top = Math.min(...beside.map((w) => w.v.t)), bottom = Math.max(...beside.map((w) => w.v.b)), first = beside.reduce((p, w) => (w.v.t < p.v.t ? w : p));
      const offBlock = Math.abs(mid(m.v) - (top + bottom) / 2), offFirst = Math.abs(mid(m.v) - mid(first.v));
      // (also: every line that is on the mark's own line, when the block is uneven: a name with a small word beside it)
      const sameLine = beside.filter((w) => Math.min(m.v.b, w.v.b) - Math.max(m.v.t, w.v.t) >= Math.min(m.v.h, w.v.h) * 0.6), offLine = sameLine.length ? Math.min(...sameLine.map((w) => Math.abs(mid(m.v) - mid(w.v)))) : 99;
      const off = Math.min(offBlock, offFirst, offLine); if (off > 1.25) flag(m, first, off, ""); }
    // Words with words of the same size on one line, in different boxes.
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) { const a = lines[i], b = lines[j]; if (a.n === b.n || composedContains(a.n, b.n) || composedContains(b.n, a.n)) continue;
      const sa = getComputedStyle(a.n), sb = getComputedStyle(b.n); if (sa.fontSize !== sb.fontSize || sa.fontFamily !== sb.fontFamily || sa.display === "inline" || sb.display === "inline") continue;
      const share = Math.min(a.v.b, b.v.b) - Math.max(a.v.t, b.v.t); if (share < Math.min(a.v.h, b.v.h) * 0.6 || Math.abs(a.v.h - b.v.h) > 1) continue;
      const off = Math.abs(mid(a.v) - mid(b.v)); if (off > 1) flag(a, b, off); }
  }

  // ---- uneven gaps between siblings that should match ---------------------------------------------------------------
  const parents = new Set(); for (const a of atoms) { const p = up(a.n); if (p) { parents.add(p); const g = up(p); if (g) parents.add(g); } }
  for (const p of parents) {
    const kids = [...p.children].filter((k) => k.checkVisibility() && getComputedStyle(k).position !== "absolute" && getComputedStyle(k).position !== "fixed" && k.getBoundingClientRect().width > 1);
    if (kids.length < 3) continue; const sig = (k) => `${k.tagName}.${typeof k.className === "string" ? k.className.split(/\s+/)[0] : ""}`;
    if (new Set(kids.map(sig)).size !== 1) continue;
    const rs = kids.map((k) => k.getBoundingClientRect());
    const sameRow = rs.every((r) => Math.abs(r.top - rs[0].top) < 1 && Math.abs(r.height - rs[0].height) < 1), sameCol = rs.every((r) => Math.abs(r.left - rs[0].left) < 1);
    if (!sameRow && !sameCol) continue;
    const gaps = rs.slice(1).map((r, i) => round(sameRow ? r.left - rs[i].right : r.top - rs[i].bottom));
    if (Math.max(...gaps) - Math.min(...gaps) > 1) out.gaps.push({ parent: name(p), kids: sig(kids[0]), n: kids.length, dir: sameRow ? "row" : "column", gaps: gaps.slice(0, 12) });
  }
  return out;
};

/** Each control's focus ring, as the keyboard would show it: is there one, does it read at 3:1, is it cut by a box that
 *  clips. Run after a real key press (so :focus-visible applies). Returns { walked, missing: [], faint: [], cut: [] }. */
export const focusAudit = (opts = {}) => {
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
  const list = [document]; const walk = (root) => { for (const n of root.querySelectorAll("*")) if (n.shadowRoot) { list.push(n.shadowRoot); walk(n.shadowRoot); } }; walk(document);
  const scopeEl = opts.scope ? list.flatMap((r) => [...r.querySelectorAll(opts.scope)])[0] : null;
  const within = (n) => { if (!opts.scope) return true; for (let p = n; p; p = up(p)) if (p === scopeEl) return true; return false; };
  const parse = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return String(c).startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = up(n)) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; } return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (ink, g) => { const c = over(parse(ink), g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const one = (n) => `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${typeof n.className === "string" && n.className.trim() ? "." + n.className.trim().split(/\s+/).slice(0, 3).join(".") : ""}`;
  const name = (e) => { const p = up(e); return p && p !== document.body ? `${one(p)} > ${one(e)}` : one(e); };
  const words = (e) => (e.getAttribute?.("aria-label") || e.textContent || e.placeholder || "").trim().replace(/\s+/g, " ").slice(0, 40);
  const FOCUS = "button:not([disabled]), input:not([type='hidden']):not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], summary, [tabindex]:not([tabindex='-1']), [contenteditable='true']";
  const look = (n) => { const s = getComputedStyle(n); return { o: s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0 ? `${s.outlineWidth} ${s.outlineStyle} ${s.outlineColor} ${s.outlineOffset}` : "", sh: s.boxShadow, bc: s.borderTopColor + s.borderBottomColor, bg: s.backgroundColor + s.backgroundImage, c: s.color, td: s.textDecorationLine }; };
  const out = { walked: 0, missing: [], faint: [], cut: [] }, seen = new Set(), before = document.activeElement;
  // (What has the keyboard now lets go first, so each control's look at rest is read at rest.)
  for (let a = document.activeElement; a; a = a.shadowRoot?.activeElement) a.blur?.();
  for (const node of list.flatMap((r) => [...r.querySelectorAll(FOCUS)])) {
    if (!within(node) || !node.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = node.getBoundingClientRect(); if (r.width < 4 || r.height < 4 || r.bottom < 0 || r.top > innerHeight) continue;
    const rest = look(node);
    try { node.focus({ preventScroll: true }); } catch { continue; }
    const root = node.getRootNode(); if ((root.activeElement || document.activeElement) !== node) continue;
    out.walked++;
    // The ring may be drawn by the control, or by the box it stands in (a field's wrapper wears it: :focus-within).
    let wearer = node, now = look(node), changed = Object.keys(now).some((k) => now[k] !== rest[k]);
    const key = one(node);
    if (!changed) { let found = false; for (let p = up(node), k = 0; p && k < 4 && !found; p = up(p), k++) { const s = getComputedStyle(p); if (p.matches(":focus-within") && ((s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) || /rgba?\(|color\(/.test(s.boxShadow))) { found = true; wearer = p; now = look(p); } }
      // (a parent's look at rest is not known here; a parent with an outline while focus is inside is its ring)
      if (!found) { if (!seen.has(key)) { seen.add(key); out.missing.push({ what: name(node), text: words(node), focusVisible: node.matches(":focus-visible") }); } continue; } }
    const s = getComputedStyle(wearer), g = ground(up(wearer) || wearer);
    let ink = "", reach = 0;
    if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) { ink = s.outlineColor; reach = Math.max(0, parseFloat(s.outlineOffset) + parseFloat(s.outlineWidth)); }
    else if (s.boxShadow !== "none" && s.boxShadow !== rest.sh) { const m = s.boxShadow.match(/(rgba?\([^)]*\)|color\([^)]*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px( inset)?/); if (m) { ink = m[1]; reach = m[6] ? 0 : parseFloat(m[5]); } }
    else if (now.bc !== rest.bc) { ink = s.borderTopColor; }
    if (ink) { const rr = ratio(ink, g); if (rr < 3 && !seen.has(key + "f")) { seen.add(key + "f"); out.faint.push({ what: name(node), text: words(node), ring: ink, ratio: rr }); } }
    if (reach > 0) { const wr = wearer.getBoundingClientRect();
      for (let p = up(wearer); p; p = up(p)) { const ps = getComputedStyle(p); if (ps.overflowX === "visible" && ps.overflowY === "visible") continue; const q = p.getBoundingClientRect();
        // Only where the control itself is whole inside the box: a row half scrolled out is cut by the scroll, not the ring.
        const inside = wr.left >= q.left - 0.5 && wr.right <= q.right + 0.5 && wr.top >= q.top - 0.5 && wr.bottom <= q.bottom + 0.5; if (!inside) break;
        const lost = Math.max(ps.overflowX !== "visible" ? Math.max(q.left - (wr.left - reach), (wr.right + reach) - q.right) : 0, ps.overflowY !== "visible" ? Math.max(q.top - (wr.top - reach), (wr.bottom + reach) - q.bottom) : 0);
        if (lost > 0.75) { if (!seen.has(key + "c")) { seen.add(key + "c"); out.cut.push({ what: name(node), text: words(node), by: one(p), lost: Math.round(lost * 10) / 10, reach }); } break; } } }
  }
  // Focus goes back to where it was (the page's body: whatever has it now lets go, through every shadow root).
  try { for (let a = document.activeElement; a; a = a.shadowRoot?.activeElement) a.blur?.(); if (before && before !== document.body) before.focus?.({ preventScroll: true }); } catch { /* nothing */ }
  return out;
};

/** The controls a pointer's hover alone shows, and what to point at to show each: [{ selector path index }] is not
 *  possible across shadow roots, so this marks each holder with data-polish-hover="<n>" and returns how many. */
export const markHoverHolders = () => {
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
  const list = [document]; const walk = (root) => { for (const n of root.querySelectorAll("*")) if (n.shadowRoot) { list.push(n.shadowRoot); walk(n.shadowRoot); } }; walk(document);
  const opacityOf = (e) => { let a = 1; for (let n = e; n; n = up(n)) a *= Number(getComputedStyle(n).opacity); return a; };
  const holders = new Map(); let n = 0;
  for (const node of list.flatMap((r) => [...r.querySelectorAll("button, [role='button'], a[href]")])) {
    if (!node.checkVisibility()) continue; const s = getComputedStyle(node), r = node.getBoundingClientRect(); if (r.width < 6 || r.height < 6 || r.bottom < 0 || r.top > innerHeight) continue;
    const hiddenNow = opacityOf(node) <= 0.05 || s.visibility === "hidden"; if (!hiddenNow) continue;
    let holder = null; for (let p = up(node); p; p = up(p)) { if (opacityOf(p) > 0.05 && getComputedStyle(p).visibility !== "hidden" && p.getBoundingClientRect().height >= r.height) { holder = p; break; } }
    if (!holder || holder === document.body) continue;
    const sig = `${holder.tagName}.${holder.className}`; const had = holders.get(sig) || 0; if (had >= 2) continue; holders.set(sig, had + 1);
    if (!holder.dataset.polishHover) holder.dataset.polishHover = String(n++);
  }
  return n;
};

/** Everything a pointer can rest on (a control, a row, a card), two of each kind: where each one's middle is, for a
 *  walk that points at each and reads the words' contrast while it is lit. Returns [{ n, x, y, what }]; each is marked
 *  data-polish-hot="<n>". */
export const markHot = (most = 70) => {
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
  const list = [document]; const walk = (root) => { for (const n of root.querySelectorAll("*")) if (n.shadowRoot) { list.push(n.shadowRoot); walk(n.shadowRoot); } }; walk(document);
  const deepHit = (x, y) => { let e = document.elementFromPoint(x, y); while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(x, y); if (!inner || inner === e) break; e = inner; } return e; };
  const contains = (a, b) => { for (let p = b; p; p = up(p)) if (p === a) return true; return false; };
  const kinds = new Map(), out = [];
  for (const node of list.flatMap((r) => [...r.querySelectorAll("button, a[href], summary, [role='button'], [role='option'], [role='menuitem'], [role='menuitemradio'], [role='tab'], li, [class*='row'], [class*='card'], [class*='tile'], [class*='item']")])) {
    if (out.length >= most) break;
    if (!node.checkVisibility({ visibilityProperty: true, opacityProperty: true }) || node.disabled) continue;
    const r = node.getBoundingClientRect(); if (r.width < 8 || r.height < 8 || r.height > 260 || r.top < 0 || r.bottom > innerHeight || r.left < 0 || r.right > innerWidth) continue;
    const sig = `${node.tagName}.${typeof node.className === "string" ? node.className.replace(/\s+/g, ".") : ""}`, had = kinds.get(sig) || 0; if (had >= 2) continue;
    // Where the pointer can rest on it: its middle, or (a card with a control in the middle) a spot near its start.
    let spot = null; for (const [fx, fy] of [[0.5, 0.5], [0.12, 0.5], [0.5, 0.2], [0.9, 0.5]]) { const x = r.left + r.width * fx, y = r.top + r.height * fy, hit = deepHit(x, y); if (hit && (hit === node || contains(node, hit))) { spot = [x, y]; break; } }
    if (!spot) continue;
    kinds.set(sig, had + 1); node.dataset.polishHot = String(out.length);
    out.push({ n: out.length, x: spot[0], y: spot[1], what: sig.toLowerCase().slice(0, 90) });
  }
  return out;
};
