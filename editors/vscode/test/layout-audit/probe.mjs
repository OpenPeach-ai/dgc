// The layout audit's measuring stick, run inside the page (page.evaluate(installProbe) puts window.__la there). It
// reads the page as it is drawn, through every shadow root: what opens a floating layer, the layer once it is open
// (where it is against the window and against the control that opened it, what lies over it, its rows, its words),
// and the page at rest (each row's height, each action a row or a bar offers, controls of one row that differ).
// Nothing here changes how the page looks, except the outlines `mark` draws for a failure's picture and takes away.
// Not a *.test.mjs file.
export const installProbe = () => {
  if (window.__la) return true;
  const up = (n) => n.parentElement || (n.getRootNode && n.getRootNode() instanceof ShadowRoot ? n.getRootNode().host : null);
  const roots = () => { const list = [document]; const walk = (root) => { for (const n of root.querySelectorAll("*")) if (n.shadowRoot) { list.push(n.shadowRoot); walk(n.shadowRoot); } }; walk(document); return list; };
  const all = (sel) => roots().flatMap((r) => [...r.querySelectorAll(sel)]);
  const contains = (a, b) => { for (let p = b; p; p = up(p)) if (p === a) return true; return false; };
  const deepHit = (x, y) => { let e = document.elementFromPoint(x, y); while (e && e.shadowRoot) { const inner = e.shadowRoot.elementFromPoint(x, y); if (!inner || inner === e) break; e = inner; } return e; };
  const deepActive = () => { let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return a; };
  const cls = (n) => (typeof n.className === "string" ? n.className : n.getAttribute?.("class") || "").trim().split(/\s+/).filter(Boolean);
  // (State a control wears for a moment is not part of what it is.)
  const STATE = /^(is-|has-|active$|open$|on$|selected$|current$|hover$|focus|busy$|running$|unread$|pinned$|waiting$|new$|vscode-)/;
  const one = (n) => `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}${cls(n).filter((c) => !STATE.test(c)).slice(0, 3).map((c) => "." + c).join("")}`;
  const name = (e) => { const p = up(e); return p && p !== document.body && p.tagName !== "HTML" ? `${one(p)} > ${one(e)}` : one(e); };
  const words = (e) => (e.getAttribute?.("aria-label") || e.getAttribute?.("title") || e.dataset?.tip || e.textContent || e.placeholder || e.value || "").trim().replace(/\s+/g, " ").slice(0, 60);
  const opacityOf = (e) => { let a = 1; for (let n = e; n; n = up(n)) a *= Number(getComputedStyle(n).opacity); return a; };
  // (Inside a closed <details> a box may still be measured: it is not drawn.)
  const laid = (n) => n.isConnected && n.getClientRects().length > 0 && n.checkVisibility();
  const shown = (n) => laid(n) && n.checkVisibility({ visibilityProperty: true, opacityProperty: true }) && opacityOf(n) > 0.05;
  const R = (r) => ({ l: r.left, t: r.top, r: r.right, b: r.bottom, w: r.width, h: r.height });
  const box = (n) => R(n.getBoundingClientRect());
  const r1 = (v) => Math.round(v * 10) / 10;
  const rr = (b) => ({ l: r1(b.l), t: r1(b.t), r: r1(b.r), b: r1(b.b), w: r1(b.w), h: r1(b.h) });
  const vw = () => document.documentElement.clientWidth, vh = () => document.documentElement.clientHeight;
  /** What of a box is left after every clipping parent has cut it (null: nothing). */
  const visible = (node, rect) => { let { l, t, r, b } = rect;
    for (let p = up(node); p; p = up(p)) { const s = getComputedStyle(p); if (s.overflowX === "visible" && s.overflowY === "visible") continue; const q = p.getBoundingClientRect();
      if (s.overflowX !== "visible") { l = Math.max(l, q.left); r = Math.min(r, q.right); } if (s.overflowY !== "visible") { t = Math.max(t, q.top); b = Math.min(b, q.bottom); } }
    l = Math.max(l, 0); t = Math.max(t, 0); r = Math.min(r, innerWidth); b = Math.min(b, innerHeight);
    return r - l > 0.5 && b - t > 0.5 ? { l, t, r, b, w: r - l, h: b - t } : null; };

  // ---- what floats: a menu, a popover, a dialog, a tooltip ------------------------------------------------------------
  const ROLE = /^(menu|listbox|dialog|alertdialog|tooltip|tree|grid)$/;
  const LOOKS = /(^|[-_ ])(menu|pop|popover|popup|dialog|modal|picker|dropdown|tip|tooltip|flyout|overlay|backdrop|scrim|veil|lightbox)([-_ ]|$)/i;
  const floats = (n) => {
    if (n.tagName === "DIALOG") return n.open;
    const s = getComputedStyle(n); if (s.position !== "fixed" && s.position !== "absolute") return false;
    if (s.position === "fixed") return true;
    return s.zIndex !== "auto" || ROLE.test(n.getAttribute("role") || "") || LOOKS.test(cls(n).join(" ")) || LOOKS.test(n.id || "");
  };
  const candidates = () => all("*").filter((n) => { if (n.tagName === "SCRIPT" || n.tagName === "STYLE" || n.closest?.("[data-la-mark]")) return false; if (!laid(n)) return false; const b = n.getBoundingClientRect(); if (b.width < 24 || b.height < 14 || !floats(n) || !shown(n)) return false;
    // (A glow, a shade or a ring drawn over the page takes no pointer and holds no words: not a layer. A hover label takes none either, and is one.)
    return getComputedStyle(n).pointerEvents !== "none" || kindOf(n) === "tooltip"; });
  const kindOf = (n) => { const role = n.getAttribute("role") || "", c = `${cls(n).join(" ")} ${n.id}`;
    if (role === "tooltip" || /(^|[-_ ])(tip|tooltip)([-_ ]|$)/i.test(c)) return "tooltip";
    if (n.tagName === "DIALOG" || /dialog/.test(role) || /(^|[-_ ])(dialog|modal|lightbox|overlay|backdrop|scrim|veil)([-_ ]|$)/i.test(c) || n.querySelector("dialog, [role='dialog'], [role='alertdialog']")) return "dialog";
    return "menu"; };

  // ---- what opens one ---------------------------------------------------------------------------------------------
  const TRIGGER = "[aria-haspopup]:not([aria-haspopup='false']), [aria-expanded], summary, [popovertarget], [data-la-trigger]";
  // Opens a layer without saying so (no aria-haspopup): found by what it is called.
  const NAMED = /(^|[-_])(more|menu|pick|picker|filter|sort|plus|kebab|dots|overflow|options|chooser|dropdown)$/i;
  const sigOf = (n) => `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}.${cls(n).filter((c) => !STATE.test(c)).sort().join(".")}`;
  const la = { trig: [], before: new Set(), layers: [] };
  const descriptor = (n) => { const sig = sigOf(n), label = words(n), same = all(n.tagName).filter((x) => sigOf(x) === sig && words(x) === label); return { sig, label, nth: Math.max(0, same.indexOf(n)) }; };
  const refind = (d) => all(d.sig.split(/[.#]/)[0] || "*").filter((x) => sigOf(x) === d.sig && words(x) === d.label)[d.nth] || all(d.sig.split(/[.#]/)[0] || "*").filter((x) => sigOf(x) === d.sig)[d.nth] || null;
  // (A view that draws itself again by changing the nodes it has may turn a control's node into another thing: a
  // control is the node that is still what it was, or the one found again by what it is.)
  const trig = (i) => { const t = la.trig[i]; if (!t) return null; if (!t.el.isConnected || (t.d.sig && sigOf(t.el) !== t.d.sig)) { const again = refind(t.d); if (again) t.el = again; } return t.el.isConnected ? t.el : null; };
  const isLayer = (l) => !!l && l.isConnected && (!l.__laSig || one(l) === l.__laSig);

  /** Every control that opens a layer, two of each kind (the first and the last in sight: a menu near the top of the
   *  window and one near its foot). `opts.scope`: a selector to stay under; `opts.inside`: only inside this open layer
   *  (a menu's own "…": a nested menu); `opts.most`: of each kind. */
  la.triggers = (opts = {}) => {
    const inRow = opts.row !== undefined ? la.hov[opts.row]?.el : null;
    const scopeEl = inRow || (opts.scope ? all(opts.scope)[0] : null), inLayer = opts.inside !== undefined ? la.layers[opts.inside] : null;
    const found = [], known = new Set(inRow ? la.trig.map((t) => t.el) : []);
    for (const el of all(`${TRIGGER}, button, [role='button']`)) {
      if (scopeEl && !contains(scopeEl, el)) continue;
      if (known.has(el)) continue;
      if (inLayer ? !contains(inLayer, el) : la.layers.some((l) => isLayer(l) && contains(l, el))) continue;
      // (By its name only when it is a glyph alone, or says "More…", "Filter", "Sort", "Options": a button with other
      // words that happens to be called "-more" is "2 more", which goes somewhere.)
      const said = el.matches(TRIGGER), named = !said && (NAMED.test(el.id || "") || cls(el).some((c) => NAMED.test(c))) && (!(el.textContent || "").trim() || /^(more|options|menu|filter|sort|show)\b/i.test(words(el)));
      if (!said && (!named || /^(menuitem|menuitemradio|menuitemcheckbox|option|tab)$/.test(el.getAttribute("role") || ""))) continue;
      // (`menus`: only what says it opens a menu, or is a "…": not a control that unfolds in place.)
      if (opts.menus && !named && !el.matches("[aria-haspopup]:not([aria-haspopup='false']), details > summary")) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true" || el.closest("[inert], [hidden]") || !laid(el)) continue;
      if (el.closest("[data-la-skip]")) continue;
      if (el.tagName === "SUMMARY" && el.parentElement?.open) continue;                       // (open already: a click would close it)
      if (el.getAttribute("aria-expanded") === "true") continue;
      // (A tab says aria-expanded nowhere; a tab, an option and a tree's row open nothing that floats.)
      if (/^(tab|option|treeitem|row)$/.test(el.getAttribute("role") || "")) continue;
      const b = el.getBoundingClientRect(); if (b.width < 6 || b.height < 6) continue;
      found.push({ el, said, sig: sigOf(el), b });
    }
    const groups = new Map(); for (const f of found) { if (!groups.has(f.sig)) groups.set(f.sig, []); groups.get(f.sig).push(f); }
    // (A layer's own controls are added after the page's, which keep their numbers.)
    const base = inLayer || inRow ? la.trig.length : 0; if (!inLayer && !inRow) la.trig = [];
    const most = opts.most || 2;
    for (const list of groups.values()) {
      const inSight = list.filter((f) => f.b.top >= 0 && f.b.bottom <= innerHeight && f.b.left >= 0 && f.b.right <= innerWidth && visible(f.el, R(f.b)));
      const from = inSight.length ? inSight.sort((p, q) => p.b.top - q.b.top || p.b.left - q.b.left) : list.slice(0, 1);
      const pick = most >= 2 && from.length > 1 ? [from[0], from[from.length - 1]] : [from[0]];
      for (const f of pick) la.trig.push({ el: f.el, d: descriptor(f.el), said: f.said, of: list.length, context: /F10/.test(f.el.getAttribute("aria-keyshortcuts") || "") });
    }
    return la.trig.map((t, i) => ({ i, what: name(t.el), label: words(t.el), sig: t.d.sig, said: t.said, of: t.of, tag: t.el.tagName.toLowerCase(), popup: t.el.getAttribute("aria-haspopup") || "", faint: !shown(t.el), context: t.context })).slice(base);
  };
  /** Rows that keep some of their controls for a pointer resting on them (not drawn, or transparent, until then): the
   *  first and the last in sight of each kind, with a point on each to rest the pointer at. */
  la.hoverRows = (opts = {}) => {
    const scopeEl = opts.scope ? all(opts.scope)[0] : null, groups = new Map();
    for (const row of all(ROW)) { if (scopeEl && !contains(scopeEl, row)) continue; if (!shown(row) || la.layers.some((l) => isLayer(l) && contains(l, row))) continue;
      const b = row.getBoundingClientRect(); if (b.height < 14 || b.height > 160 || b.width < 60 || b.top < 0 || b.bottom > innerHeight) continue;
      const kept = [...row.querySelectorAll("button, [role='button'], a[href]")].some((c) => !c.closest("[hidden]") && (!laid(c) || !shown(c))); if (!kept) continue;
      let spot = null; for (const [fx, fy] of [[0.5, 0.5], [0.2, 0.5], [0.08, 0.5], [0.5, 0.25], [0.8, 0.5]]) { const x = b.left + b.width * fx, y = b.top + b.height * fy, hit = deepHit(x, y); if (hit && (hit === row || contains(row, hit))) { spot = [x, y]; break; } }
      if (!spot) continue; const sig = one(row); if (!groups.has(sig)) groups.set(sig, []); groups.get(sig).push({ el: row, x: spot[0], y: spot[1], sig }); }
    la.hov = []; for (const list of groups.values()) { la.hov.push(list[0]); if ((opts.most || 2) > 1 && list.length > 1) la.hov.push(list[list.length - 1]); }
    return la.hov.map((h, i) => ({ i, x: h.x, y: h.y, what: h.sig }));
  };
  /** Where trigger `i` is now (after a scroll that brings it into sight), and what a pointer at its middle would hit. */
  la.aim = (i) => { const el = trig(i); if (!el) return null;
    let b = el.getBoundingClientRect();
    if (b.top < 0 || b.bottom > innerHeight || b.left < 0 || b.right > innerWidth) { el.scrollIntoView({ block: "nearest", inline: "nearest" }); b = el.getBoundingClientRect(); }
    const v = visible(el, R(b)); if (!v) return { gone: true };
    const x = (v.l + v.r) / 2, y = (v.t + v.b) / 2, hit = deepHit(x, y);
    return { x, y, rect: rr(R(b)), shown: shown(el), hit: !!hit && (hit === el || contains(el, hit)), by: hit && hit !== el && !contains(el, hit) && !contains(hit, el) ? name(hit) : "", tab: el.tabIndex,
      composite: !!el.closest("[role='toolbar'], [role='tablist'], [role='menu'], [role='menubar'], [role='listbox'], [role='grid'], [role='tree'], [role='radiogroup']")
        // (a group the arrow keys walk: one of its controls is the Tab stop, the rest are reached from it)
        || !!(el.parentElement && [...el.parentElement.children].some((c) => c !== el && c.tabIndex === 0 && c.tagName === el.tagName)) };
  };
  la.snap = () => { la.before = new Set(candidates()); la.layers = la.layers.map((l) => (isLayer(l) && shown(l) ? l : null));   /* (a layer keeps its number while the walk goes on) */ const el = deepActive(); la.focusWas = el; return la.before.size; };
  la.click = (i) => { const el = trig(i); if (!el) return false; el.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, composed: true })); el.click(); return true; };
  la.focus = (i) => { const el = trig(i); if (!el) return { ok: false }; try { el.focus({ preventScroll: true }); } catch { /* not focusable */ } return { ok: deepActive() === el, tab: el.tabIndex }; };

  const corners = (b) => { const ix = Math.min(8, b.w / 4), iy = Math.min(8, b.h / 4); return [["top left", b.l + ix, b.t + iy], ["top right", b.r - ix, b.t + iy], ["bottom left", b.l + ix, b.b - iy], ["bottom right", b.r - ix, b.b - iy], ["middle", (b.l + b.r) / 2, (b.t + b.b) / 2]]; };
  /** One open layer against the window and against the control that opened it. */
  const measure = (layer, el, k) => {
    const kind = kindOf(layer), W = vw(), H = vh();
    // A dialog's box is the panel inside its scrim, when it has one.
    let boxEl = layer;
    if (kind === "dialog") { const b = layer.getBoundingClientRect(); if (b.width >= W - 2 && b.height >= H - 2) { const inner = [...layer.querySelectorAll("*")].find((n) => { const q = n.getBoundingClientRect(), s = getComputedStyle(n); return q.width > 40 && q.height > 40 && (q.width < W - 2 || q.height < H - 2) && (s.backgroundColor !== "rgba(0, 0, 0, 0)" || s.borderTopWidth !== "0px" || s.boxShadow !== "none"); }); if (inner) boxEl = inner; } }
    const L = box(boxEl), T = el && el.isConnected ? box(el) : null, s = getComputedStyle(boxEl);
    const out = { k, kind, what: name(boxEl), rect: rr(L), trigger: T ? rr(T) : null, win: [W, H], off: {}, covered: [], rows: null, radius: s.borderTopLeftRadius, scrolls: /auto|scroll/.test(s.overflowY) || [...boxEl.children].some((c) => /auto|scroll/.test(getComputedStyle(c).overflowY)) };
    for (const [side, by] of [["left", -L.l], ["top", -L.t], ["right", L.r - W], ["bottom", L.b - H]]) if (by > 0.75) out.off[side] = r1(by);
    // What a pointer finds at its corners and its middle: the layer, or something lying over it (or a box cutting it).
    if (getComputedStyle(layer).pointerEvents !== "none") for (const [where, x, y] of corners(L)) {
      if (x < 0 || y < 0 || x > W || y > H) continue;
      const hit = deepHit(x, y); if (hit && !contains(layer, hit) && !contains(hit, layer)) out.covered.push({ where, by: name(hit), text: words(hit).slice(0, 30) });
    }
    // Cut by a box that clips (an absolute menu inside a list that hides what runs over).
    if (getComputedStyle(layer).position !== "fixed" && layer.tagName !== "DIALOG") { const v = visible(boxEl, L); if (!v) out.cut = { all: true }; else if (v.w < Math.min(L.r, W) - Math.max(L.l, 0) - 1 || v.h < Math.min(L.b, H) - Math.max(L.t, 0) - 1) out.cut = { shows: `${r1(v.w)}x${r1(v.h)}`, of: `${r1(L.w)}x${r1(L.h)}` }; }
    if (T && kind === "menu") {
      const ow = Math.min(L.r, T.r) - Math.max(L.l, T.l), oh = Math.min(L.b, T.b) - Math.max(L.t, T.t);
      out.coversTrigger = ow > 1.5 && oh > 1.5 && !contains(el, layer) ? `${r1(ow)}x${r1(oh)}` : "";
      const below = L.t >= T.b - 1.5, above = L.b <= T.t + 1.5, right = L.l >= T.r - 1.5, left = L.r <= T.l + 1.5;
      out.side = below ? "below" : above ? "above" : right ? "right" : left ? "left" : "over";
      out.gap = r1(below ? L.t - T.b : above ? T.t - L.b : right ? L.l - T.r : left ? T.l - L.r : 0);
      const M = 12;      // a layer kept inside the window by its margin is lined up with the window, not its button
      const upDown = below || above || !(right || left);
      const offs = upDown ? { start: L.l - T.l, end: L.r - T.r, centre: (L.l + L.r) / 2 - (T.l + T.r) / 2 } : { start: L.t - T.t, end: L.b - T.b, centre: (L.t + L.b) / 2 - (T.t + T.b) / 2 };
      const clamped = upDown ? (L.l <= M + 0.5 || L.r >= W - M - 0.5) : (L.t <= M + 0.5 || L.b >= H - M - 0.5);
      let how = Object.entries(offs).find(([, v]) => Math.abs(v) <= 2)?.[0] || "";
      // The surface's own rule may be the box the control stands in (a prompt box's menu spans the box, or starts at its edge).
      let near = out.gap;
      for (let p = up(el), n = 0; p && n < 6; p = up(p), n++) { if (p === document.body || p.tagName === "HTML") break; const q = box(p); if (q.w >= W - 1 && q.h >= H - 1) break; if (q.w < T.w + 4 && q.h < T.h + 4) continue;
        const a = upDown ? [L.l - q.l, L.r - q.r] : [L.t - q.t, L.b - q.b]; if (!how && q.w < W - 1 && (Math.abs(a[0]) <= 2 || Math.abs(a[1]) <= 2)) how = `the box it stands in (${one(p)})`;
        // (…or that box holds it in by its margin, as the window does: its control is nearer the box's edge than the margin.)
        if (!how && ((offs.end < -2 && a[1] <= 0 && a[1] >= -12) || (offs.start > 2 && a[0] >= 0 && a[0] <= 12))) how = `held inside ${one(p)} by its margin`;
        // (how far it stands from that box: a prompt box's menus open over the whole box, not over the button)
        const g = below ? L.t - q.b : above ? q.t - L.b : right ? L.l - q.r : left ? q.l - L.r : 0; if (g >= -1 && g < near) near = r1(g); }
      out.gapToBox = near;
      // …or the layer is laid in the page's flow under its control's own box (a details menu that fills its column).
      if (!how && clamped) how = "the window's edge";
      out.align = { how, start: r1(offs.start), end: r1(offs.end), centre: r1(offs.centre), across: upDown ? "sideways" : "up and down" };
    }
    // Its rows: one height (a row with a second line under its name is its own height).
    const rowEls = [...boxEl.querySelectorAll(".dgc-menu-row, [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='option']")].filter((r) => laid(r) && !r.closest("[hidden]"));
    if (rowEls.length) { const plain = rowEls.filter((r) => !r.matches(".dgc-menu-row-sub, .dgc-swatch") && !r.querySelector(".dgc-menu-sub, small, .sub, [class*='-sub'], [class*='detail'], [class*='desc'], [class*='hint']:not(.dgc-menu-hint), br")); const hs = plain.map((r) => r1(r.getBoundingClientRect().height));
      const count = {}; for (const h of hs) count[h] = (count[h] || 0) + 1; const usual = Number(Object.entries(count).sort((a, b) => b[1] - a[1])[0]?.[0] || 0);
      out.rows = { n: rowEls.length, usual, odd: plain.filter((r) => Math.abs(r.getBoundingClientRect().height - usual) > 1).slice(0, 4).map((r) => `“${words(r).slice(0, 30)}” ${r1(r.getBoundingClientRect().height)}px`), radius: plain[0] ? getComputedStyle(plain[0]).borderTopLeftRadius : "", font: plain[0] ? getComputedStyle(plain[0]).fontSize : "" }; }
    const active = deepActive(); out.focusInside = !!active && contains(layer, active);
    out.focusOnTrigger = !!active && !!el && active === el;
    return out;
  };
  /** The layers that are open now and were not at the last snap, measured against trigger `i` (-1: none). Each is
   *  marked data-la-layer="<k>" for a words audit or a picture. */
  la.opened = (i) => {
    const el = i >= 0 ? trig(i) : null;
    let fresh = candidates().filter((n) => !la.before.has(n) && !(el && contains(n, el)));
    fresh = fresh.filter((n) => !fresh.some((m) => m !== n && contains(m, n)));
    // (What a <details> shows belongs to its own summary: one that another control's press finds open is not that control's layer.)
    if (el) fresh = fresh.filter((n) => { const d = n.closest?.("details"); return !d || contains(d, el); });
    // (The page's own hover label may come up under the pointer; it is read by the tooltip walk, not here.)
    const tips = fresh.filter((n) => kindOf(n) === "tooltip"); fresh = fresh.filter((n) => kindOf(n) !== "tooltip");
    const out = [];
    for (const n of fresh) { const k = la.layers.push(n) - 1; n.setAttribute("data-la-layer", String(k)); n.__laSig = one(n); out.push(measure(n, el, k)); }
    const expanded = el ? (el.tagName === "SUMMARY" ? !!el.parentElement?.open : el.getAttribute("aria-expanded") === "true") : false;
    let disclosure = null;
    if (!out.length && el && expanded) {
      const target = el.tagName === "SUMMARY" ? el.parentElement : (el.getAttribute("aria-controls") && el.getRootNode().getElementById?.(el.getAttribute("aria-controls"))) || el.nextElementSibling || el.parentElement;
      if (target && laid(target)) { const b = box(target); target.setAttribute("data-la-layer", "d"); disclosure = { what: name(target), rect: rr(b), offRight: r1(Math.max(0, b.r - vw())), offLeft: r1(Math.max(0, -b.l)) }; }
    }
    return { layers: out, disclosure, expanded, tips: tips.length, focus: (() => { const a = deepActive(); return a ? name(a) : ""; })() };
  };
  /** After the key that should close it: is layer `k` gone, and where the focus is. */
  la.closed = ([k, i]) => { const l = la.layers[k], el = i >= 0 ? trig(i) : null, a = deepActive(), open = isLayer(l) && shown(l) && l.getBoundingClientRect().width > 4;
    if (!open) l?.removeAttribute?.("data-la-layer");
    return { open, focusBack: !!el && (a === el || contains(el, a)), focus: a && a !== document.body ? `${name(a)} “${words(a).slice(0, 30)}”` : "nothing (the page's body)", expanded: el ? (el.tagName === "SUMMARY" ? !!el.parentElement?.open : el.getAttribute("aria-expanded") === "true") : false }; };
  /** Whatever the walk opened and is still open is closed, by what the layer is: a <details>, a <dialog>, its own
   *  Close. Returns what was still open (a walk that leaves a layer open would measure it again on the next control). */
  la.closeLeft = () => { const left = [];
    for (let k = 0; k < la.layers.length; k++) { const l = la.layers[k]; if (!isLayer(l) || !shown(l)) { la.layers[k] = null; continue; }
      left.push(name(l));
      const d = l.closest("details[open]") || (l.getRootNode().host ? null : null); if (d) d.open = false;
      else if (l.tagName === "DIALOG" && l.open) l.close();
      else { const b = [...l.querySelectorAll("button, [role='button']")].find((x) => /^(close|cancel|done|not now)\b/i.test(words(x))); if (b) b.click(); }
      l.removeAttribute("data-la-layer"); la.layers[k] = null; }
    // (A <details> the walk opened, by its summary: closed when the walk found it.)
    for (const t of la.trig) if (t.el && t.el.isConnected && t.el.tagName === "SUMMARY" && t.el.parentElement && t.el.parentElement.open) { t.el.parentElement.open = false; left.push(name(t.el)); }
    // (…and any <details> whose open part floats over the page: a menu. One that unfolds in the page's flow is left as it is.)
    for (const d of all("details[open]")) if ([...d.children].some((c) => c.tagName !== "SUMMARY" && laid(c) && floats(c))) { d.open = false; left.push(name(d)); }
    return left; };
  la.unmarkDisclosure = () => { for (const n of all("[data-la-layer='d']")) n.removeAttribute("data-la-layer"); };
  /** Closes what Escape did not: its own Close or Cancel, else a press outside. Returns how. */
  la.forceClose = (k) => { const l = la.layers[k]; if (!isLayer(l)) return "gone";
    const b = [...l.querySelectorAll("button, [role='button']")].find((x) => /^(close|cancel|done|not now|back)\b/i.test(words(x))); if (b) { b.click(); return "its own button"; }
    if (l.tagName === "DIALOG" && l.open) { l.close(); return "dialog.close()"; }
    return ""; };

  // ---- tooltips ---------------------------------------------------------------------------------------------------
  /** Things that say what they are on hover (title or data-tip), a few of each kind, near each edge first. */
  la.tipHosts = (opts = {}) => {
    const scopeEl = opts.scope ? all(opts.scope)[0] : null, seen = new Map(), list = [];
    for (const el of all("[title], [data-tip]")) { if (scopeEl && !contains(scopeEl, el)) continue; const label = (el.getAttribute("title") || el.dataset.tip || "").trim(); if (!label || !shown(el)) continue;
      const b = el.getBoundingClientRect(); if (b.width < 4 || b.height < 4 || b.top < 0 || b.bottom > innerHeight || b.left < 0 || b.right > innerWidth) continue; const v = visible(el, R(b)); if (!v) continue;
      const x = (v.l + v.r) / 2, y = (v.t + v.b) / 2, hit = deepHit(x, y); if (!hit || !(hit === el || contains(el, hit))) continue;
      list.push({ el, label, sig: sigOf(el), x, y, b: R(b) }); }
    list.sort((p, q) => p.b.t - q.b.t || p.b.l - q.b.l);
    la.tips = [];
    const most = opts.most || 14, take = (f) => { if (!f || la.tips.includes(f) || la.tips.length >= most) return; const n = seen.get(f.sig) || 0; if (n >= 2) return; seen.set(f.sig, n + 1); la.tips.push(f); };
    // The ones nearest each edge of the window first (where a label would run off), then one of every other kind.
    const by = (fn) => [...list].sort((p, q) => fn(p) - fn(q))[0];
    take(by((f) => f.b.l)); take(by((f) => -f.b.r)); take(by((f) => f.b.t)); take(by((f) => -f.b.b));
    for (const f of list) take(f);
    return la.tips.map((f, i) => ({ i, what: name(f.el), label: f.label, x: f.x, y: f.y, rect: rr(f.b) }));
  };
  const tipNodes = () => all("[role='tooltip'], .dgc-tip, .tip, #hover-tip").filter((n) => shown(n) && n.getBoundingClientRect().width > 4 && (n.textContent || "").trim());
  /** The labels that are up before the pointer moves (one left up by something else is not this control's). */
  la.tipSnap = () => { la.tipsWere = new Map(tipNodes().map((n) => [n, `${n.textContent}|${Math.round(n.getBoundingClientRect().left)}|${Math.round(n.getBoundingClientRect().top)}`])); return la.tipsWere.size; };
  /** Does a hover label that is up now (and was not before the pointer moved) say these words? */
  la.tipSays = (full) => tipNodes().some((n) => (!la.tipsWere || la.tipsWere.get(n) !== `${n.textContent}|${Math.round(n.getBoundingClientRect().left)}|${Math.round(n.getBoundingClientRect().top)}`) && (n.textContent || "").replace(/\s+/g, " ").includes(full));
  la.tipNow = (i) => { const f = la.tips[i]; const tips = tipNodes().filter((n) => !la.tipsWere || la.tipsWere.get(n) !== `${n.textContent}|${Math.round(n.getBoundingClientRect().left)}|${Math.round(n.getBoundingClientRect().top)}`);
    if (!tips.length) return null;
    const n = tips[tips.length - 1], L = box(n), T = f.el.isConnected ? box(f.el) : f.b, W = vw(), H = vh(), off = {};
    for (const [side, by] of [["left", -L.l], ["top", -L.t], ["right", L.r - W], ["bottom", L.b - H]]) if (by > 0.75) off[side] = r1(by);
    const ow = Math.min(L.r, T.r) - Math.max(L.l, T.l), oh = Math.min(L.b, T.b) - Math.max(L.t, T.t);
    // Its own words: the first text of the host (a row's name), which the label must not lie over.
    let wordsBox = null; const walker = document.createTreeWalker(f.el, NodeFilter.SHOW_TEXT); for (let t = walker.nextNode(); t; t = walker.nextNode()) { if (!t.nodeValue.trim()) continue; const range = document.createRange(); range.selectNodeContents(t); const q = range.getBoundingClientRect(); if (q.width > 1) { wordsBox = R(q); break; } }
    const overWords = wordsBox ? Math.min(L.r, wordsBox.r) - Math.max(L.l, wordsBox.l) > 1.5 && Math.min(L.b, wordsBox.b) - Math.max(L.t, wordsBox.t) > 1.5 : false;
    n.setAttribute("data-la-layer", "tip");
    // What is under the pointer now: a row that draws its buttons where its date stood, once a pointer rests on it, has
    // put one of them there, and the label is that button's own.
    const said = (n.textContent || "").trim().replace(/\s+/g, " "), hitNow = deepHit(f.x, f.y);
    // (…or the control the pointer was put on is simply not what is under it any more: the label is not about it.)
    let underSays = !!hitNow && f.el.isConnected && !(hitNow === f.el || contains(f.el, hitNow));
    for (let p = deepHit(f.x, f.y), k = 0; p && k < 5 && !underSays; p = up(p), k++) { const label = `${p.getAttribute?.("aria-label") || ""}\n${p.getAttribute?.("title") || ""}\n${p.dataset?.tip || ""}`.split("\n").map((x) => x.trim()).filter(Boolean); underSays = label.some((x) => said.startsWith(x.slice(0, 20)) || x.startsWith(said.slice(0, 20))); }
    return { text: said, rect: rr(L), host: rr(T), off, overHost: ow > 1.5 && oh > 1.5 ? `${r1(ow)}x${r1(oh)}` : "", overWords, what: name(n), underSays };
  };

  // ---- the page at rest -------------------------------------------------------------------------------------------
  const ROW = "li, [role='row'], [role='listitem'], [role='option'], [class$='-row'], [class*='-row '], [class$='_row'], .row, [class*='-row-slot']";
  const BAR = "header, [role='toolbar'], [class*='head'], [class*='bar'], [class*='tools'], [class*='actions'], footer, form, nav";
  const CONTROL = "button, [role='button'], a[href], select, summary, [role='tab'], [role='switch'], input:not([type='hidden'])";
  const alpha = (c) => { const m = String(c).match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return m[3] ?? 1; };
  /** A row's (or a card's, or a bar's) own name, so "Pin Mornings" and "Pin Tides" are one action. */
  // (Its row first: a row's own little bar of buttons belongs to the row, whose "…" may hold what the bar drops.)
  const ownerOf = (n) => { let card = null, bar = null;
    let tall = null, group = null;
    for (let p = up(n), k = 0; p && k < 7; p = up(p), k++) { if (p.matches?.(ROW)) { if (p.getBoundingClientRect().height <= 160) return { el: p, kind: "row" }; tall = tall || p; } if (!card && p.matches?.("[class$='card'], [class*='card '], article, [class$='tile'], [class*='tile ']")) card = p; if (!bar && p.matches?.(BAR)) bar = p; if (!group && p.matches?.("section, fieldset, [role='group'], [role='region'], dialog, [role='dialog']")) group = p; }
    // (A row grown tall at a narrow width, its buttons under its words, is still that row; and a control in none of these belongs to the part of the page it is in.)
    return card ? { el: card, kind: "card" } : bar ? { el: bar, kind: "bar" } : tall ? { el: tall, kind: "row" } : group ? { el: group, kind: "bar" } : null; };
  // Not an action of its own: a dock's tile is a shortcut to a thing that has its own row in a list (the dock's "+" is one).
  const NOT_ACTION = ".dgc-dock-item:not(.dgc-dock-add)";
  const actionName = (n, owner) => { let w = (n.getAttribute("aria-label") || n.getAttribute("title") || n.dataset?.tip || n.textContent || "").split("\n")[0].replace(/\s+/g, " ").trim();
    w = w.replace(/[:：].*$/, "").replace(/[“"‘'][^”"’']*[”"’']/g, "").trim();
    if (owner) { const title = (owner.el.querySelector("[class*='name'], [class*='title'], strong, b, h1, h2, h3, h4")?.textContent || "").replace(/\s+/g, " ").trim(); if (title && title.length > 2 && w.length > title.length + 2 && w.includes(title)) w = w.replace(title, "").replace(/\s+/g, " ").trim(); }
    return w.replace(/\b\d[\d,.]*\b/g, "#").replace(/\s+(for|of|on|in|to|from)$/i, "").slice(0, 90); };
  /** Each row kind's height, and each action a row, a card or a bar offers, with whether it is drawn and can be
   *  pointed at here. Asked at every width of the sweep and compared with the widest. */
  la.read = (opts = {}) => {
    const scopeEl = opts.scope ? all(opts.scope)[0] : null, W = vw();
    const rows = {}, actions = {}, over = [], offside = [];
    const inLayer = (n) => la.layers.some((l) => isLayer(l) && contains(l, n));
    for (const row of all(ROW)) { if (scopeEl && !contains(scopeEl, row)) continue; if (!shown(row) || inLayer(row)) continue; const b = row.getBoundingClientRect(); if (b.height < 14 || b.height > 120 || b.width < 60) continue;
      if (!row.querySelector(CONTROL) && !row.matches(CONTROL) && !row.matches("[tabindex]")) continue;
      const sig = one(row); const had = rows[sig]; const h = r1(b.height);
      if (!had) { // The first row of its kind: its height, and how many lines its words take (a row that grows because its words wrap is one thing; a row that grows or shrinks with the same lines is another).
        const tops = []; const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT); const range = document.createRange(); let seen = 0;
        for (let t = walker.nextNode(); t && seen < 40; t = walker.nextNode()) { if (!t.nodeValue.trim() || !t.parentElement || !shown(t.parentElement)) continue; seen++; range.selectNodeContents(t); for (const q of range.getClientRects()) if (q.width > 1 && q.height > 4 && !tops.some((y) => Math.abs(y - q.top) < q.height / 2)) tops.push(q.top); }
        // (and its controls: a row whose buttons go under its words at a narrow width has one line more)
        const shownControls = [...row.querySelectorAll(CONTROL)].filter((c) => shown(c));
        for (const c of shownControls) { const q = c.getBoundingClientRect(); if (q.height > 4 && q.height < b.height - 4 && !tops.some((y) => Math.abs(y - q.top) < Math.max(q.height, 14) * 0.75)) tops.push(q.top); }
        rows[sig] = { h, min: h, max: h, n: 1, lines: tops.length, shownControls: shownControls.length };
      } else { had.n++; had.min = Math.min(had.min, h); had.max = Math.max(had.max, h); } }
    const groups = new Map();
    for (const c of all(CONTROL)) { if (scopeEl && !contains(scopeEl, c)) continue; if (inLayer(c) || c.closest("[hidden], [inert]") || c.matches(NOT_ACTION)) continue;
      const owner = ownerOf(c); if (!owner) continue;
      // (A row's own body, the button that is the row and says its name, is the row: not one of the actions it offers.)
      if (c.matches(ROW)) continue;
      if (owner.kind === "row" && laid(c)) { const q = c.getBoundingClientRect(), o = owner.el.getBoundingClientRect(); if (q.width * q.height > o.width * o.height * 0.6) continue; }
      const act = actionName(c, owner); if (!act || act.length < 2) continue;
      const key = `${owner.kind} ${one(owner.el)} › ${act}`;
      const isLaid = laid(c), b = isLaid ? c.getBoundingClientRect() : null;
      // Reachable here: drawn, with a box to press, inside its clipping parents and the window (a box that scrolls
      // up and down may hold it out of sight: that is reached by scrolling), and not left transparent for good.
      let ok = false, faint = false, why = isLaid ? "" : "not drawn (display: none)";
      if (isLaid) { if (b.width < 4 || b.height < 4) why = `drawn at ${r1(b.width)}x${r1(b.height)}px`;
        else { let l = b.left, r = b.right; for (let p = up(c); p; p = up(p)) { const s = getComputedStyle(p); if (s.overflowX === "visible" || /auto|scroll/.test(s.overflowX)) continue; const q = p.getBoundingClientRect(); l = Math.max(l, q.left); r = Math.min(r, q.right); }
          l = Math.max(l, 0); r = Math.min(r, W);
          if (r - l < Math.min(8, b.width) - 0.5) why = `cut away sideways (${r1(Math.max(0, r - l))} of ${r1(b.width)}px shows)`;
          else if (getComputedStyle(c).visibility === "hidden") { faint = true; ok = true; }
          else { ok = true; faint = opacityOf(c) <= 0.05; } } }
      // (and the outermost card it is in: a card of Home's grid holds smaller cards and tiles)
      let outer = null; for (let p = up(owner.el); p; p = up(p)) if (p.matches?.("[class$='card'], [class*='card '], article")) outer = p;
      const had = actions[key] || (actions[key] = { ok: false, faint: true, n: 0, why: "", tab: false, owner: one(owner.el), outer: outer ? one(outer) : "", kind: owner.kind, act });
      had.n++; if (ok) { had.ok = true; if (!faint) had.faint = false; if (c.tabIndex >= 0 || c.closest("[role='toolbar'], [role='tablist'], [role='menu'], [role='listbox'], [role='grid'], [role='radiogroup']")) had.tab = true; } else if (!had.why) had.why = why;
      if (ok && !faint && b) { if (b.right > W + 1 || b.left < -1) offside.push({ what: name(c), text: words(c).slice(0, 30), left: r1(b.left), right: r1(b.right) });
        const p = up(c); if (p) { if (!groups.has(p)) groups.set(p, []); groups.get(p).push({ c, b: R(b) }); } }
    }
    // Two controls of one row lying on each other.
    for (const list of groups.values()) for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const a = list[i], b = list[j]; if (contains(a.c, b.c) || contains(b.c, a.c)) continue;
      // (A tile or a card that is itself a button, with its small buttons on it, is a layout of its own.)
      const big = (x) => x.b.w > 44 || x.b.h > 44; if (big(a) || big(b)) continue;
      const w = Math.min(a.b.r, b.b.r) - Math.max(a.b.l, b.b.l), h = Math.min(a.b.b, b.b.b) - Math.max(a.b.t, b.b.t); if (w > 2 && h > 2) over.push({ a: name(a.c), aText: words(a.c).slice(0, 24), b: name(b.c), bText: words(b.c).slice(0, 24), by: `${r1(w)}x${r1(h)}` }); }
    const page = document.documentElement.scrollWidth > W + 1 ? document.documentElement.scrollWidth - W : 0;
    return { width: innerWidth, rows, actions, over, offside, page };
  };
  /** The last row of each kind of list, with the list at its end: what a pointer finds at its middle (the row, or
   *  something lying over it: the dock, a bar that stays). */
  la.lastRows = (opts = {}) => { const scopeEl = opts.scope ? all(opts.scope)[0] : null, last = new Map();
    for (const row of all(ROW)) { if (scopeEl && !contains(scopeEl, row)) continue; if (!laid(row) || la.layers.some((l) => isLayer(l) && contains(l, row))) continue; const b = row.getBoundingClientRect(); if (b.height < 14 || b.height > 160 || b.width < 60) continue; last.set(one(row), row); }
    const out = [];
    for (const [sig, row] of last) { const b = box(row); if (b.b < 0 || b.t > innerHeight) { out.push({ sig, text: words(row).slice(0, 40), rect: rr(b), out: true }); continue; }
      // (The foot of the window is where a list's end meets the dock: a row of some card further up, scrolled under the head bar, is not a list's end.)
      if (b.b < innerHeight * 0.5) continue;
      const v = visible(row, b); const pts = [[(b.l + b.r) / 2, (b.t + b.b) / 2], [b.l + 16, b.b - 4], [b.r - 16, b.b - 4]]; let by = "";
      for (const [x, y] of pts) { if (y > innerHeight || y < 0) { by = "the window's edge"; break; } const hit = deepHit(x, y); if (hit && !contains(row, hit) && !contains(hit, row)) { by = name(hit); break; } }
      if (!v) by = by || "a box that clips"; if (by) out.push({ sig, text: words(row).slice(0, 40), rect: rr(b), by }); }
    return out; };
  /** The rows of the open menus (what an action that left the row may have moved into). */
  la.menuWords = () => la.layers.filter((l) => isLayer(l) && shown(l)).flatMap((l) => [...l.querySelectorAll("button, [role^='menuitem'], [role='option'], a[href]")].filter(laid).map((r) => {
    // (A row's own words: a row that is off carries why as its title, which is not its name.)
    const said = (r.querySelector(".dgc-menu-label")?.textContent || r.textContent || "").replace(/\s+/g, " ").trim(); return said ? said.replace(/[:：].*$/, "").slice(0, 48) : actionName(r, null); }));

  /** Controls of one row that differ, controls outside the button family, and words that end in "…" with nothing that
   *  says the rest. */
  la.rest = (opts = {}) => {
    const scopeEl = opts.scope ? all(opts.scope)[0] : null, out = { mates: [], family: [], dots: [], kinds: {} }, seenM = new Set(), seenF = new Set(), seenD = new Set();
    const boxed = (c, s) => (parseFloat(s.borderTopWidth) > 0 && alpha(s.borderTopColor) > 0.05 && s.borderTopStyle !== "none") || alpha(s.backgroundColor) > 0.05;
    const groups = new Map();
    for (const c of all("button, [role='button'], select, input:not([type='hidden']):not([type='checkbox']):not([type='radio']):not([type='range']):not([type='file']), a.dgc-btn")) {
      if (scopeEl && !contains(scopeEl, c)) continue; if (!shown(c)) continue;
      const b = c.getBoundingClientRect(); if (b.width < 8 || b.height < 8 || !visible(c, R(b))) continue;
      const s = getComputedStyle(c);
      // Its words as drawn (words kept for a screen reader in a 1 px box are not): the width of what shows.
      let text = "", wide = 0; { const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT), range = document.createRange(); for (let t = walker.nextNode(); t; t = walker.nextNode()) { if (!t.nodeValue.trim() || !t.parentElement) continue; const pb = t.parentElement.getBoundingClientRect(); if (pb.width <= 2 || pb.height <= 2 || !shown(t.parentElement)) continue; range.selectNodeContents(t); const q = range.getBoundingClientRect(); if (q.width > 2) { wide += q.width; text += ` ${t.nodeValue.trim()}`; } } text = text.trim(); }
      const field = c.matches("input, select"), isBoxed = boxed(c, s), icon = !field && !text && !!c.querySelector("svg, .codicon, img, [data-mark]");
      const kind = field ? "field" : icon ? "icon button" : isBoxed ? "button" : "plain button";
      const p = up(c); if (p) { if (!groups.has(p)) groups.set(p, []); groups.get(p).push({ c, b: R(b), kind, s }); }
      // The button family (media/shared/tokens.css: --btn-h 28, --btn-h-sm 22, --btn-r 6): a boxed button whose words
      // are a command is 28 or 22 px tall with the 6 px corner, never a pill. Not held to it, each a kind of its own: a
      // row of a menu or a list, a tab or a segment of a switch, a chip that names a thing (a file, a queued message),
      // a card or a tile that is itself a button, a key of a PIN pad, and what is round on purpose
      // (one-shape-controls.test.mjs: a send button, a swatch, an "i").
      const ROUND = ".dgc-dock-item, .dgc-dock-item *, .dgc-blob-button, [data-mark], .session-blob, .dgc-swatch, .dgc-swatch *, [role='switch'], .switch, .csend, #send, #stop, .cd-send, .chat-send, .vb-btn, .vb-send, .info, .pip-tip-btn, .msg-choice-key";
      const OTHER = "[role^='menuitem'], [role='option'], [role='tab'], [role='row'], [role='radio'], .dgc-menu-row, .chip, [class*='chip'], [class*='-seg'] > *, .seg, [class*='tile'], [class*='card'], [class*='-row'], [class*='-li']";
      if (kind === "button" && !c.matches(ROUND) && !c.matches(OTHER) && !c.closest("[role='menu'], [role='listbox'], [role='tablist'], [role='radiogroup'], nav, [class*='-seg'], [class*='-pad'], .dgc-menu, [class*='-menu']") && b.width < 280 && b.height <= 44 && wide > 6 && !/\n/.test((c.innerText || "").trim())) {
        const radius = parseFloat(s.borderTopLeftRadius) || 0, h = r1(b.height), sig = one(c);
        const badH = Math.abs(h - 28) > 0.6 && Math.abs(h - 22) > 0.6, badR = Math.abs(radius - 6) > 0.6;
        if ((badH || badR) && !seenF.has(sig)) { seenF.add(sig); out.family.push({ what: name(c), text: text.slice(0, 30), h, radius: r1(radius), w: r1(b.width), badH, badR, pill: radius >= h / 2 - 1 && b.width > h + 6, at: rr(R(b)) }); }
      }
      const kk = out.kinds[kind] || (out.kinds[kind] = {}); const key = `${Math.round(b.height)}px tall, corner ${s.borderTopLeftRadius}`; (kk[key] = kk[key] || []).length < 3 && kk[key].push(one(c));
    }
    // Two controls of one row (same parent, on one line): one height for the same kind, and one centre line.
    for (const [p, list] of groups) { if (list.length < 2) continue;
      for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) { const a = list[i], b = list[j];
        if (a.b.h > 44 || b.b.h > 44) continue;                                                                                      // a card or a tile that is a button: not a row's control
        const share = Math.min(a.b.b, b.b.b) - Math.max(a.b.t, b.b.t); if (share < Math.min(a.b.h, b.b.h) * 0.6) continue;         // not on one line
        if (Math.min(a.b.r, b.b.r) - Math.max(a.b.l, b.b.l) > 2) continue;                                                           // one over the other
        const dh = Math.abs(a.b.h - b.b.h), dc = Math.abs((a.b.t + a.b.b) / 2 - (b.b.t + b.b.b) / 2);
        // One height for two boxes that are drawn (a button with a box, a field); a button drawn as words or as a
        // glyph alone has no box to compare, only its centre line.
        const drawn = (x) => x.kind === "button" || x.kind === "field";
        const problem = drawn(a) && drawn(b) && dh > 1 ? `heights ${r1(a.b.h)} and ${r1(b.b.h)}px` : dc > 1 ? `centres ${r1(dc)}px apart` : "";
        if (!problem) continue; const key = `${one(p)}|${one(a.c)}|${one(b.c)}`; if (seenM.has(key)) continue; seenM.add(key);
        out.mates.push({ row: name(p), a: `${one(a.c)} “${words(a.c).slice(0, 20)}” (${a.kind}, ${r1(a.b.h)}px)`, b: `${one(b.c)} “${words(b.c).slice(0, 20)}” (${b.kind}, ${r1(b.b.h)}px)`, problem, at: rr({ l: Math.min(a.b.l, b.b.l), t: Math.min(a.b.t, b.b.t), r: Math.max(a.b.r, b.b.r), b: Math.max(a.b.b, b.b.b), w: 0, h: 0 }) }); } }
    // Words ending in "…" whose whole text nothing says (no title, data-tip or aria-label on it or the control it is in).
    for (const root of roots()) { const walker = document.createTreeWalker(root === document ? document.body : root, NodeFilter.SHOW_TEXT);
      for (let t = walker.nextNode(); t; t = walker.nextNode()) { const e = t.parentElement; if (!e || !t.nodeValue.trim() || (scopeEl && !contains(scopeEl, e))) continue;
        let n = e; while (n && getComputedStyle(n).display === "inline") n = up(n); if (!n || seenD.has(n)) continue;
        const s = getComputedStyle(n); if (s.textOverflow !== "ellipsis" || s.overflowX === "visible" || n.scrollWidth <= n.clientWidth + 1) continue; seenD.add(n);
        if (!shown(n) || !visible(n, box(n)) || n.clientWidth <= 2 || /inset\(\s*(50|100)%/.test(s.clipPath)) continue;      // (words kept for a screen reader in a 1 px box are not cut words)
        const full = n.textContent.trim().replace(/\s+/g, " "); let said = false;
        for (let p = n, k = 0; p && k < 5 && !said; p = up(p), k++) { const label = `${p.getAttribute("title") || ""} ${p.dataset?.tip || ""} ${p.getAttribute("aria-label") || ""} ${p.getAttribute("aria-description") || ""}`; if (label.includes(full.slice(0, 24))) said = true; }
        // (A menu's row slides a long name into sight while it is pointed at or focused: media/shared/menu.js.)
        if (!said && (n.matches(".dgc-menu-label") || n.closest("dgc-path, .dgc-path"))) said = true;
        // (Only where a pointer can rest on it: a line that lies under a bar that stays, or behind an open dialog, is not asked.)
        if (!said) { const q = box(n), x = q.l + Math.min(q.w / 2, 40), y = (q.t + q.b) / 2, hit = x >= 0 && y >= 0 && x <= innerWidth && y <= innerHeight ? deepHit(x, y) : null;
          if (hit && (hit === n || contains(n, hit) || contains(hit, n))) { const sig = one(n); out.dots.push({ what: name(n), sig, text: full.slice(0, 50), shown: n.clientWidth, needs: n.scrollWidth, at: rr(q) }); } } } }
    return out;
  };

  // ---- a failure's picture: the control and the layer, outlined ---------------------------------------------------------
  la.mark = (boxes) => { la.unmark(); const holder = document.createElement("la-mark"); holder.setAttribute("data-la-mark", "1"); holder.style.cssText = "display:block !important;position:fixed;inset:0;pointer-events:none;z-index:2147483647;visibility:visible;opacity:1";
    for (const { rect, colour, label } of boxes) { if (!rect) continue; const d = document.createElement("la-box"); d.style.cssText = `display:block !important;position:fixed;left:${rect.l - 1}px;top:${rect.t - 1}px;width:${rect.w}px;height:${rect.h}px;border:2px ${colour === "blue" ? "dashed #2f81f7" : "solid #f0363f"};box-sizing:content-box;border-radius:2px`;
      if (label) { const s = document.createElement("la-label"); s.textContent = label; s.style.cssText = `display:block !important;position:absolute;left:-2px;${rect.t > 16 ? "top:-15px" : "bottom:-15px"};font:600 10px/13px system-ui,sans-serif;padding:0 3px;white-space:nowrap;color:#fff;background:${colour === "blue" ? "#2f81f7" : "#f0363f"}`; d.append(s); }
      holder.append(d); }
    document.body.append(holder); return true; };
  la.unmark = () => { for (const n of document.querySelectorAll("[data-la-mark]")) n.remove(); return true; };
  la.rectOf = (sel) => { const n = all(sel)[0]; return n && laid(n) ? rr(box(n)) : null; };
  la.name = name; la.words = words; la.all = all; la.shown = shown; la.contains = contains;
  window.__la = la;
  return true;
};
