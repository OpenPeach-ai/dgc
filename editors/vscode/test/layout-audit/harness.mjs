// The layout audit's walk (0.52): on a real page in real Chromium it opens every pop-up, dropdown, menu, popover,
// tooltip and dialog the page has, measures each against the window and the control that opened it, and reads the page
// at rest and across a sweep of widths. What is off is a finding, with a picture (the control dashed blue, the layer
// red). probe.mjs is the measuring stick inside the page; surfaces.mjs says which pages, at which sizes; allow.mjs is
// the list of findings left on purpose, each with its reason. Not a *.test.mjs file.
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { installProbe } from "./probe.mjs";
import { narrowAudit } from "../support/narrow-audit.mjs";
import { ACTION_OF } from "../support/uir2c-scene.mjs";

export const HERE = dirname(fileURLToPath(import.meta.url));
// What a run writes (none of it is kept in the repository: .gitignore beside this file): report.md, report.json,
// pictures/ and parts/ (one file of findings for each part of the audit that ran).
export const OUT = process.env.DGC_LAYOUT_AUDIT_OUT || HERE;
export const PICTURES = join(OUT, "pictures");
export const PARTS = join(OUT, "parts");

/** What each check is called in the report, most serious first (the brief's order: off-screen, covering, unreachable). */
export const CHECKS = [
  ["offscreen", "Drawn outside the window", "A layer (or a control) has a part outside the window."],
  ["covered", "Covered, or covering what it shouldn't", "A layer lies under something, is cut by a box that clips, covers the control that opened it, or a label lies over its own words."],
  ["unreachable", "An action that can't be reached", "A row, bar or card offers an action at the widest width that no control and no menu offers at a narrower one; or a control only a hover shows."],
  ["keyboard", "Keyboard: can't open it, Escape doesn't close it, or the focus is lost", "A layer the keyboard can't open or get into, that Escape leaves open, or that doesn't hand the focus back to its control."],
  ["aligned", "Not lined up with its control", "A menu's edge or centre is more than 2 px from its control's (or from the box its control stands in)."],
  ["cut", "Words cut", "A word cut with no “…”, a word broken across lines, a button's own words cut, an “…” with nothing that says the rest, or a box that scrolls sideways."],
  ["heights", "Heights and corners", "A button outside the family (28 or 22 px, 6 px corner), two controls of one row that differ, or a menu's rows of two heights."],
  ["rows", "A row that changes with the width", "A list row's height at one width is not its height at another, or two of a row's controls lie on each other."],
  ["consistency", "One kind of control, two looks", "The same kind of control measured on two surfaces: a different height, corner or type size."],
  ["icons", "One action, two icons", "Two controls with one action draw different glyphs, or one glyph at two sizes."],
];
const RANK = Object.fromEntries(CHECKS.map(([id], i) => [id, i]));
/** What the report says about its own sizes: the brief asks for every surface at every width, height and setting, and
 *  the audit has to run with the suite (about ten minutes, ten pages at a time), so some of it is sampled. */
const SAMPLING = [
  "- **Layers** (every pop-up, dropdown, menu, popover and dialog; two of each kind of control on a page, the first and the last in sight, so one near the head of the window and one near its foot): at 300, 360, 440, 700 and 1000 px wide and 760 tall in dark; at 300×640 and 700×800 in light; at 440×480 and 700×1000 (a short and a tall window; with the two above that is every height the brief names: 480, 640, 800, 1000); with the editor's font at 18 px; and with forced colours and reduced motion. A page that is the side bar under 600 px and an editor tab above (the Pips view) is opened as each. Opened again by the keyboard (Enter, Space or Down; Shift+F10 where a control says so), with Escape and the focus's way back, at the first size of the dark pass: what a key does is not a matter of the width.",
  "- **Hover labels**: twelve of a page's controls (the nearest to each edge of the window first, then one of every kind) at the first size of the dark pass. A label's delay is 700 to 800 ms, so every control of every page at every size is not affordable; the edges are where a label runs off.",
  "- **The width sweep**: a page's first state every 20 px from 260 to 1200 and at 170 (the side bar's real minimum): 49 widths. Its other states (the same rows and bars with other content: a long list, another tab of the Library, a Pip's page) at ten sampled widths (170, 260, 300, 360, 440, 560, 700, 840, 1000, 1200): the full sweep of every state is about four times the audit's whole time. `DGC_LAYOUT_SWEEP=full` sweeps every state every 20 px.",
  "- **Words** (cut, broken, a sideways scrollbar): at rest at every size above, and in the sweep at 260, 360, 440, 560, 700, 1000 and 1200 (170, 220 and 300 on every page are narrowest-words-browser.test.mjs's).",
  "- **Settings**: dark and light; forced colours with reduced motion, and VS Code's high-contrast class (the page at rest); the font at 12 px (the page at rest) and 18 px (layers too); a screen with no hover (every action in sight without one). Editor zoom is the font size here: a webview's zoom scales the whole page, which changes no layout.",
  "- **Content**: lists of 200 with names that are very long, have no spaces, are not Latin, run right to left or are emoji, and numbers from 1 to 12,345; each list at its top and scrolled to its end (its last row against the dock), with the dock shown and hidden; chats with the same words. Empty, one thing, many, busy (a reply running), waiting (a command to allow), and the dialogs, are the scenes' own states.",
];

// How patient the walk is: 1 on a machine at rest. The audit runs with the rest of the suite, twenty test files at a
// time, and a page that answers a press in 20 ms alone may take half a second then: every wait below is this many
// times as long (measured before each state: how long the page takes to come back from one frame).
let PACE = 1;
export async function pace(page) { let worst = 0;
  for (let k = 0; k < 3; k++) { const t = Date.now(); await page.evaluate(() => new Promise((d) => requestAnimationFrame(() => setTimeout(d, 0)))).catch(() => {}); worst = Math.max(worst, Date.now() - t); }
  PACE = Math.max(1, Math.min(6, worst / 45)); return PACE; }
const settle = (page, ms = 120) => page.evaluate((n) => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, n)))), Math.round(ms * PACE)).catch(() => {});
/** Until the page has drawn and what is moving has come to rest (a menu popping in, a tile swelling), `most` ms at the
 *  longest: two frames, then every running animation and transition that ends is waited for. */
const rested = (page, most = 260, least = 30) => page.evaluate(([cap, floor]) => new Promise((done) => { const t0 = performance.now(); const end = () => setTimeout(done, Math.max(0, floor - (performance.now() - t0)));
  requestAnimationFrame(() => requestAnimationFrame(() => { const all = []; const walk = (root) => { try { all.push(...root.getAnimations()); } catch { /* none */ } for (const n of root.querySelectorAll("*")) if (n.shadowRoot) walk(n.shadowRoot); };
    walk(document); const moving = all.filter((a) => a.playState === "running" && a.effect && Number.isFinite(a.effect.getComputedTiming().endTime) && a.effect.getComputedTiming().iterations !== Infinity);
    if (!moving.length) return end(); const left = Math.max(0, cap - (performance.now() - t0)); Promise.race([Promise.allSettled(moving.map((a) => a.finished)), new Promise((r) => setTimeout(r, left))]).then(end); })); }), [Math.round(most * PACE), Math.round(least * PACE)]).catch(() => {});
const probe = (page) => page.evaluate(installProbe);
const la = (page, fn, arg) => page.evaluate(([f, a]) => window.__la[f](a), [fn, arg]);
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
// Boxes that scroll sideways on purpose: what they hold is wider than any side bar by its nature (narrowest-words-browser.test.mjs).
const SCROLLS_ON_PURPOSE = /(^|> )pre\b|\bcode\b|table|\.katex|\.mermaid|\.dgc-sheet|\.cv-/;

/** One run's findings and counts. */
export class Audit {
  constructor(part) { this.part = part; this.found = new Map(); this.stats = { layers: 0, menus: 0, dialogs: 0, disclosures: 0, tooltips: 0, triggers: 0, nested: 0, keyboard: 0, widths: 0, pages: 0, states: 0, pictures: 0, unopened: [], opened: {}, sweeps: [], notes: [], ms: {} }; this.kinds = {}; this.menus = {}; this.shots = 0; this.says = new Set(); this.once = new Map(); }
  /** A finding: `what` is its stable name (one line in the report however many widths it shows at), `says` the sentence. */
  add(check, ctx, what, says, extra = {}) {
    const key = `${check}|${ctx.surface}|${what}`;
    let f = this.found.get(key);
    if (!f) { f = { check, surface: ctx.surface, what, says, at: [], picture: "", ...extra }; this.found.set(key, f); }
    const at = `${ctx.state} ${ctx.width}×${ctx.height} ${ctx.theme}${ctx.variant ? " " + ctx.variant : ""}`;
    if (!f.at.includes(at)) f.at.push(at);
    return f;
  }
  /** A finding that counts once it is seen a second time (at another size, in another pass, or on a second try): what
   *  a key does in a view that draws itself again on its own clock (the Pips view) can go wrong once for that reason
   *  alone, and a real fault goes wrong every time. Returns the finding once it counts, else null. */
  twice(check, ctx, what, says) {
    const key = `${check}|${ctx.surface}|${what}`, at = `${ctx.state} ${ctx.width}×${ctx.height} ${ctx.theme}${ctx.variant ? " " + ctx.variant : ""}`;
    if (this.found.has(key)) return this.add(check, ctx, what, says);
    const first = this.once.get(key);
    if (!first) { this.once.set(key, { ctx, at }); return null; }
    if (first.at === at) return null;
    this.add(check, first.ctx, what, says); return this.add(check, ctx, what, says);
  }
  /** A picture for a finding that has none yet: `boxes` are [{ rect, colour: "blue" | "red", label }]. */
  async picture(page, finding, boxes) {
    if (!finding || finding.picture || this.shots >= 400) return;
    finding.picture = "pending";
    try {
      mkdirSync(PICTURES, { recursive: true });
      const size = page.viewportSize(), rects = boxes.map((b) => b.rect).filter(Boolean);
      if (!rects.length) { finding.picture = ""; return; }
      await la(page, "mark", boxes);
      const pad = 28, l = Math.max(0, Math.min(...rects.map((r) => r.l)) - pad), t = Math.max(0, Math.min(...rects.map((r) => r.t)) - pad);
      const r = Math.min(size.width, Math.max(...rects.map((q) => q.r)) + pad), b = Math.min(size.height, Math.max(...rects.map((q) => q.b)) + pad);
      const file = `${String(++this.shots).padStart(3, "0")}-${this.part}-${finding.check}-${slug(finding.surface)}-${slug(finding.what).slice(0, 40)}.png`;
      const clip = { x: Math.floor(l), y: Math.floor(t), width: Math.max(40, Math.ceil(r - l)), height: Math.max(40, Math.ceil(b - t)) };
      clip.width = Math.min(clip.width, size.width - clip.x); clip.height = Math.min(clip.height, size.height - clip.y);
      await page.screenshot({ path: join(PICTURES, file), clip, animations: "disabled" });
      finding.picture = `pictures/${file}`; this.stats.pictures++;
    } catch { finding.picture = ""; } finally { await la(page, "unmark").catch(() => {}); }
  }
  save() {
    mkdirSync(PARTS, { recursive: true });
    const body = { part: this.part, at: new Date().toISOString(), stats: this.stats, kinds: this.kinds, menus: this.menus, table: this.table || null, missing: this.missing || [], findings: [...this.found.values()].map((f) => ({ ...f, picture: f.picture === "pending" ? "" : f.picture })) };
    writeFileSync(join(PARTS, `${this.part}.json`), JSON.stringify(body, null, 1));
    return body;
  }
}

const TRACE = !!process.env.DGC_LAYOUT_AUDIT_TRACE, trace = (...a) => { if (TRACE) console.error("   ·", ...a); };
const sentenceOff = (off) => Object.entries(off).map(([side, by]) => `${by}px past the ${side}`).join(", ");

/** Opens every layer the page has (see probe.mjs: la.triggers) and measures each. opts: { scope, keyboard (also open
 *  each with the keyboard, and check Escape and the focus), words (audit the layer's words), nested, extra: [{ name,
 *  anchor, open(page), context }] layers a pointer or the keyboard opens another way (a right-click, a typed "@") }. */
export async function auditLayers(page, audit, ctx, opts = {}) {
  await probe(page);
  const size = page.viewportSize();
  ctx = { ...ctx, width: size.width, height: size.height };
  const list = await la(page, "triggers", { scope: opts.scope || "", most: opts.most || 2 });
  const wait = opts.wait || 170;
  // `bag`: where what it finds is put instead of the report (the pointer's first try: tried once more before it counts).
  const judge = async (m, t, how, parentRect, bag = null) => {
    audit.stats.layers++; audit.stats[m.kind === "dialog" ? "dialogs" : "menus"]++;
    const openedKey = `${ctx.surface} › ${t.label || t.what}`; audit.stats.opened[openedKey] = (audit.stats.opened[openedKey] || 0) + 1;
    const nameOf = `${t.label ? `“${t.label}”` : t.what} (${t.sig.split(".")[0]}${t.sig.includes("#") ? "" : "." + (t.sig.split(".").filter(Boolean)[1] || "")})`;
    const boxes = [{ rect: m.trigger, colour: "blue", label: "control" }, { rect: m.rect, colour: "red", label: m.kind }];
    const put = (check, c, what, says) => { if (bag) { bag.push({ check, what, says, boxes }); return null; } return audit.add(check, c, what, says); };
    const shoot = (f) => (f ? audit.picture(page, f, boxes) : null);
    if (Object.keys(m.off).length) await shoot(put("offscreen", ctx, `layer of ${nameOf}`, `The ${m.kind} that ${nameOf} opens (${m.what}) runs ${sentenceOff(m.off)} of the window.`));
    if (m.cut) await shoot(put("covered", ctx, `layer of ${nameOf} is cut`, `The ${m.kind} that ${nameOf} opens (${m.what}) is cut by a box that clips: ${m.cut.all ? "none of it shows" : `${m.cut.shows} of its ${m.cut.of} px show`}.`));
    if (m.covered.length) { const by = [...new Set(m.covered.map((c) => c.by))].slice(0, 2).join(", "); await shoot(put("covered", ctx, `layer of ${nameOf} lies under ${by}`, `The ${m.kind} that ${nameOf} opens (${m.what}) lies under ${by} at its ${m.covered.map((c) => c.where).join(", ")}.`)); }
    if (m.kind === "menu" && !t.context) {
      if (m.coversTrigger) await shoot(put("covered", ctx, `layer of ${nameOf} covers its control`, `The menu that ${nameOf} opens (${m.what}) covers the control that opened it (${m.coversTrigger} px of it).`));
      if (m.align && !m.align.how && !m.coversTrigger) await shoot(put("aligned", ctx, `layer of ${nameOf}`, `The menu that ${nameOf} opens (${m.what}) is not lined up with it ${m.align.across}: its start is ${m.align.start}px from the control's, its end ${m.align.end}px, its centre ${m.align.centre}px (and it is not held by the window's edge or the box the control stands in).`));
      if (m.gapToBox > 24 && m.align) await shoot(put("aligned", ctx, `layer of ${nameOf} stands off`, `The menu that ${nameOf} opens (${m.what}) is ${m.gap}px away from it (${m.side}), and ${m.gapToBox}px from the nearest box it stands in.`));
    }
    if (m.rows && m.rows.odd.length) await shoot(put("heights", ctx, `rows of the layer of ${nameOf}`, `In the ${m.kind} that ${nameOf} opens, rows are ${m.rows.usual}px tall but ${m.rows.odd.join(", ")}.`));
    if (m.rows && m.rows.n >= 2 && m.kind === "menu" && !ctx.variant) { const bag = audit.menus[ctx.surface] || (audit.menus[ctx.surface] = {}); const key = `${Math.round(m.rows.usual)}px rows, ${m.rows.font} type, row corner ${m.rows.radius}`; (bag[key] = bag[key] || []).length < 4 && !bag[key].includes(t.label || t.what) && bag[key].push(t.label || t.what); }
    if (opts.words !== false) {
      const w = await page.evaluate(narrowAudit, { scope: `[data-la-layer="${m.k}"]` }).catch(() => null);
      if (w) for (const [key, label] of [["broken", "is drawn on more than one line"], ["cut", "is cut with no “…”"], ["clipped", "(a button's own words) is cut"]]) for (const x of w[key]) await shoot(put("cut", ctx, `in the layer of ${nameOf}: “${x.text}” ${key}`, `In the ${m.kind} that ${nameOf} opens, “${x.text}” ${label} (${x.what}).`));
      if (w) for (const x of w.sideways) if (!SCROLLS_ON_PURPOSE.test(x.what)) await shoot(put("cut", ctx, `the layer of ${nameOf} scrolls sideways`, `In the ${m.kind} that ${nameOf} opens, ${x.what} scrolls sideways (${x.text}).`));
    }
    void how; void parentRect;
  };
  // `faults`: where a fault is put (the keyboard's try collects its own, to try once more before it counts); without
  // it a fault counts once it is seen twice (Audit.twice).
  const closeAll = async (res, i, t, { expectFocus, faults = null }) => {
    for (const m of res.layers) {
      await page.keyboard.press("Escape"); await rested(page, 200, 40);
      let c = await la(page, "closed", [m.k, i]).catch(() => ({ open: false, focusBack: true }));
      // (A layer may take a moment to go: it is asked again before it is called open.)
      for (let n = 0; n < 3 && c.open; n++) { await settle(page, 130); c = await la(page, "closed", [m.k, i]).catch(() => ({ open: false, focusBack: true })); }
      trace("  Escape →", c.open ? "still open" : "closed", "focus:", c.focus, c.focusBack ? "(back)" : "");
      if (c.open) {
        const nameOf = t.label ? `“${t.label}”` : t.what;
        const fault = [`Escape leaves the layer of ${nameOf} open`, `Escape does not close the ${m.kind} that ${nameOf} opens (${m.what}).`];
        if (faults) faults.push(fault); else { const f = audit.twice("keyboard", ctx, ...fault); if (f) await audit.picture(page, f, [{ rect: m.trigger, colour: "blue", label: "control" }, { rect: m.rect, colour: "red", label: "still open after Escape" }]); }
        const how = await la(page, "forceClose", m.k).catch(() => "");
        await settle(page, 120);
        c = await la(page, "closed", [m.k, i]).catch(() => ({ open: false }));
        // (Its own control pressed again closes it: not where the control's plain press is another action, as a dock tile's, which goes to its Pip.)
        if (c.open && !t.context) { const a = await la(page, "aim", i).catch(() => null); if (a && !a.gone) { await page.mouse.click(a.x, a.y).catch(() => {}); await settle(page, 120); c = await la(page, "closed", [m.k, i]).catch(() => ({ open: false })); } }
        if (c.open) await page.evaluate(() => { if (window.DgcBlob?.isOpen?.()) window.DgcBlob.close(); }).catch(() => {});
        if (c.open) { await page.mouse.click(2, 2).catch(() => {}); await settle(page, 120); }
        void how;
      } else if (expectFocus && !c.focusBack) {
        const nameOf = t.label ? `“${t.label}”` : t.what;
        const fault = [`focus after the layer of ${nameOf} closes`, `After Escape closes the ${m.kind} that ${nameOf} opens, the focus is on ${c.focus}, not back on the control.`];
        if (faults) faults.push(fault); else audit.twice("keyboard", ctx, ...fault);
      }
    }
  };
  const openOne = async (t, depth = 0) => {
    audit.stats.triggers++;
    const i = t.i, aim = await la(page, "aim", i);
    if (!aim || aim.gone) return;
    // (The pointer rests a moment first, as a person's does: a dock's tiles swell under it, a row draws its buttons.)
    await page.mouse.move(aim.x, aim.y); await rested(page, 220, t.faint || /dock/.test(t.sig) ? 150 : 40);
    const now = (await la(page, "aim", i)) || aim;
    if (now.gone) return;
    await la(page, "snap");
    // (A control that says its menu is on Shift+F10 opens it on a right-click; its plain click is its own action.)
    if (t.context) await page.mouse.click(now.x, now.y, { button: "right" }); else if (now.hit) await page.mouse.click(now.x, now.y); else await la(page, "click", i);
    await rested(page, 320, 60);
    let res = await la(page, "opened", i).catch(() => null);
    trace(ctx.state, ctx.width, "press", t.label || t.what, "→", res ? res.layers.map((m) => `${m.kind} ${m.what} ${m.rect.w}x${m.rect.h} focusIn=${m.focusInside}`).join(" | ") || (res.disclosure ? "unfolds " + res.disclosure.what : "nothing") : "error");
    if (!res) return;
    if (!res.layers.length && !res.disclosure) { if (t.said && t.popup && t.popup !== "false") audit.stats.unopened.push(`${ctx.surface} ${ctx.state} ${ctx.width}px: ${t.label || t.what}`); return; }
    if (res.disclosure) {
      audit.stats.disclosures++;
      if (res.disclosure.offRight > 1 || res.disclosure.offLeft > 1) { const f = audit.add("offscreen", ctx, `what “${t.label}” unfolds`, `What “${t.label}” unfolds (${res.disclosure.what}) runs ${res.disclosure.offRight || res.disclosure.offLeft}px past the window's ${res.disclosure.offRight > 1 ? "right" : "left"}.`); await audit.picture(page, f, [{ rect: now.rect, colour: "blue", label: "control" }, { rect: res.disclosure.rect, colour: "red", label: "unfolded" }]); }
      await la(page, "unmarkDisclosure");
      // Folded again, as it was.
      const again = await la(page, "aim", i); if (again && !again.gone) { if (again.hit) await page.mouse.click(again.x, again.y); else await la(page, "click", i); await settle(page, 80); }
      return;
    }
    // What is off is tried once more before it counts: a view that draws itself again on its own clock (the Pips view)
    // can put a layer in the wrong place once, and a real fault does it every time.
    { const bag = []; for (const m of res.layers) await judge(m, t, "pointer", null, bag);
      if (bag.length) {
        await page.keyboard.press("Escape").catch(() => {}); await la(page, "closeLeft").catch(() => {}); await page.mouse.move(1, 1).catch(() => {}); await settle(page, 260);
        const a2 = await la(page, "aim", i);
        if (a2 && !a2.gone) {
          await page.mouse.move(a2.x, a2.y); await rested(page, 260, t.faint || /dock/.test(t.sig) ? 180 : 80);
          const n2 = (await la(page, "aim", i)) || a2; await la(page, "snap");
          if (t.context) await page.mouse.click(n2.x, n2.y, { button: "right" }); else if (n2.hit) await page.mouse.click(n2.x, n2.y); else await la(page, "click", i);
          await rested(page, 360, 90);
          const res2 = await la(page, "opened", i).catch(() => null);
          if (res2 && res2.layers.length) { const again = []; for (const m of res2.layers) await judge(m, t, "pointer", null, again); res = res2;
            for (const f of again) if (bag.some((x) => x.check === f.check && x.what === f.what)) await audit.picture(page, audit.add(f.check, ctx, f.what, f.says), f.boxes); }
          else if (res2) res = { ...res, layers: [] };
        } } }
    // A menu's own "…": a menu over a menu (and a menu over a dialog).
    if (opts.nested !== false && depth < 1) for (const m of res.layers) {
      const inner = await la(page, "triggers", { inside: m.k, most: 1 }).catch(() => []);
      for (const n of inner.slice(0, 4)) { audit.stats.nested++;
        const a2 = await la(page, "aim", n.i); if (!a2 || a2.gone) continue;
        await page.mouse.move(a2.x, a2.y); await settle(page, 30); await la(page, "snap");
        if (a2.hit) await page.mouse.click(a2.x, a2.y); else await la(page, "click", n.i);
        await rested(page, 320, 60);
        const r2 = await la(page, "opened", n.i).catch(() => null);
        trace("  inside:", n.label || n.what, "→", r2 ? r2.layers.map((m2) => `${m2.kind} ${m2.what}`).join(" | ") || "nothing" : "error");
        if (r2 && r2.layers.length) { for (const m2 of r2.layers) await judge(m2, { ...n, label: `${t.label || t.what} › ${n.label || n.what}` }, "pointer"); await page.keyboard.press("Escape"); await settle(page, 90); }
        else if (r2 && r2.disclosure) { await la(page, "unmarkDisclosure"); }
      }
    }
    // Is the outer layer still there (a nested Escape may have closed both)? Then Escape closes it and the focus goes back.
    // (Where the focus goes back is asked in the plain passes: a pass that has just changed the page's colours, font or
    // size is on a page that may be drawing itself again, which takes the focus with it for a moment.)
    await closeAll(res, i, t, { expectFocus: !ctx.variant });
    if (!opts.keyboard) return;
    // The same layer by the keyboard: its control takes the focus, Enter (or Space, or Down) opens it, the focus goes
    // into it, Escape closes it and puts the focus back. Tried once more before a fault counts.
    audit.stats.keyboard++;
    const nameOf = t.label ? `“${t.label}”` : t.what, kind0 = res.layers[0].kind;
    const byKeyboard = async () => {
      const f0 = await la(page, "focus", i).catch(() => ({ ok: false }));
      if (!f0.ok) return [[`${nameOf} can't take the focus`, `${nameOf} (${t.what}) opens a ${kind0} but can't take the keyboard's focus.`]];
      const a3 = await la(page, "aim", i), faults = [];
      if (f0.tab < 0 && a3 && !a3.composite) faults.push([`${nameOf} is not a Tab stop`, `${nameOf} (${t.what}) opens a ${kind0} but is not in the Tab order (tabindex ${f0.tab}) and is not inside a group the arrow keys walk.`]);
      let got = null;
      for (const key of t.context ? ["Shift+F10"] : ["Enter", "Space", "ArrowDown"]) { await la(page, "snap"); await page.keyboard.press(key); await rested(page, 320, 60); const r = await la(page, "opened", i).catch(() => null); if (r && r.layers.length) { got = r; break; } if (r && r.disclosure) { await la(page, "unmarkDisclosure"); return faults; } const still = await la(page, "focus", i).catch(() => ({ ok: false })); if (!still.ok) break; }
      if (!got) { await page.keyboard.press("Escape"); return [...faults, [`the keyboard doesn't open the layer of ${nameOf}`, `With the focus on ${nameOf} (${t.what}), ${t.context ? "Shift+F10 opens" : "Enter, Space and Down open"} nothing; a ${t.context ? "right-click" : "click"} opens a ${kind0}.`]]; }
      let m = got.layers[0];
      // Into it: at once, or on Down (a menu's rows), or on Tab (a panel that is the next thing after its button).
      const inside = () => page.evaluate((k) => { const l = window.__la.layers[k]; let a = document.activeElement; while (a && a.shadowRoot && a.shadowRoot.activeElement) a = a.shadowRoot.activeElement; return !!l && !!a && (window.__la.contains(l, a) || !!a.getAttribute("aria-activedescendant")); }, m.k).catch(() => true);
      if (!m.focusInside && m.kind !== "dialog") { await page.keyboard.press("ArrowDown"); await settle(page, 60); m = { ...m, focusInside: await inside() }; }
      if (!m.focusInside) { await page.keyboard.press("Tab"); await settle(page, 60); m = { ...m, focusInside: await inside() }; }
      if (!m.focusInside) faults.push([`the focus doesn't go into the layer of ${nameOf}`, `Opened by the keyboard, the ${m.kind} that ${nameOf} opens (${m.what}) doesn't take the focus (not at once, not on Down, not on Tab).`]);
      await closeAll(got, i, t, { expectFocus: true, faults });
      return faults;
    };
    let faults = await byKeyboard();
    if (faults.length) { await la(page, "closeLeft").catch(() => {}); await page.mouse.move(1, 1).catch(() => {}); await settle(page, 400);
      const was = PACE; PACE = Math.min(8, PACE * 3);      // (the second try waits three times as long for each key's answer)
      try { const again = await byKeyboard(); faults = again.filter(([what]) => faults.some(([w]) => w === what)); } finally { PACE = was; } }
    for (const [what, says] of faults) audit.add("keyboard", ctx, what, says);
  };
  const run = async (t) => { try { await openOne(t); } catch (error) { audit.stats.notes.push(`${ctx.surface} ${ctx.state}: ${t.label || t.what}: ${String(error.message || error).split("\n")[0].slice(0, 140)}`); await page.keyboard.press("Escape").catch(() => {}); }
    // Nothing the walk opened stays open for the next control (a <details> menu Escape does not close has been said above).
    if (!opts.keepOpen) { const left = await la(page, "closeLeft").catch(() => []); if (left.length) await settle(page, 60); }
    if (TRACE) trace("   after", ctx.surface, ctx.state, ctx.width, t.label || t.what, "→ body:", await page.evaluate(() => document.body.className).catch(() => "?")); };
  // `opts.stay`: asked after each control; false when the page has left the view this state is (the walk stops here).
  const stay = async (t) => !opts.stay || (await opts.stay(`“${t.label || t.what}”`));
  for (const t of list) { await run(t); if (!(await stay(t))) return; }
  // Rows that show some of their controls only to a pointer resting on them: the pointer rests there, and what the row
  // then offers is opened too.
  if (opts.hover !== false) { const rows = await la(page, "hoverRows", { scope: opts.scope || "" }).catch(() => []);
    for (const h of rows) { await page.mouse.move(h.x, h.y); await settle(page, 60); const more = await la(page, "triggers", { row: h.i, most: 1 }).catch(() => []); for (const t of more) { await page.mouse.move(h.x, h.y); await run(t); if (!(await stay(t))) return; } } }
  // The layers something else opens: a right-click, a typed character.
  for (const x of opts.extra || []) {
    try {
      await la(page, "snap");
      const anchor = x.anchor ? await la(page, "rectOf", x.anchor) : null;
      await x.open(page); await settle(page, wait + 60);
      const res = await page.evaluate((sel) => { const L = window.__la; L.trig = []; const el = sel ? L.all(sel)[0] : null; if (el) L.trig.push({ el, d: { sig: "", label: "", nth: 0 }, said: true, of: 1 }); return L.opened(el ? 0 : -1); }, x.anchor || "");
      const t = { i: 0, label: x.name, what: x.anchor || x.name, sig: `${x.anchor || "x"}.`, said: true, context: !!x.context };
      if (!res.layers.length) audit.stats.unopened.push(`${ctx.surface} ${ctx.state} ${ctx.width}px: ${x.name}`);
      for (const m of res.layers) await judge({ ...m, trigger: m.trigger || anchor }, t, "extra");
      if (x.close) await x.close(page); else await closeAll(res, res.layers.length && x.anchor ? 0 : -1, t, { expectFocus: false });
      await settle(page, 60);
    } catch (error) { audit.stats.notes.push(`${ctx.surface} ${ctx.state}: ${x.name}: ${String(error.message || error).split("\n")[0].slice(0, 140)}`); await page.keyboard.press("Escape").catch(() => {}); }
  }
  await page.mouse.move(1, 1).catch(() => {});
}

/** The layers that are open already (a scene that opened a menu or a dialog itself): against the window only. */
export async function auditOpen(page, audit, ctx, opts = {}) {
  await probe(page);
  const size = page.viewportSize(); ctx = { ...ctx, width: size.width, height: size.height };
  const res = await page.evaluate(() => { const L = window.__la; L.before = new Set(); L.trig = []; const r = L.opened(-1);
    // A menu, a list to pick from or a dialog: by its role, or by what it is called (not a bar that stays, the dock, a glow).
    return r.layers.filter((m) => { const n = L.layers[m.k]; const yes = n.tagName === "DIALOG" || /^(menu|listbox|dialog|alertdialog)$/.test(n.getAttribute("role") || "") || !!n.querySelector("[role='dialog'], [role='alertdialog'], dialog[open]") || /(^|[-_ ])(menu|pop|popover|dialog|modal|picker|overlay|scrim)([-_ ]|$)/i.test(`${n.className} ${n.id}`);
      if (!yes || m.rect.w < 60 || m.rect.h < 30) { n.removeAttribute("data-la-layer"); L.layers[m.k] = null; } return yes && m.rect.w >= 60 && m.rect.h >= 30; }); });
  for (const m of res) {
    audit.stats.layers++; audit.stats[m.kind === "dialog" ? "dialogs" : "menus"]++;
    const key = `${ctx.surface} › ${ctx.state} (open)`; audit.stats.opened[key] = (audit.stats.opened[key] || 0) + 1;
    const boxes = [{ rect: m.rect, colour: "red", label: m.kind }];
    if (Object.keys(m.off).length) await audit.picture(page, audit.add("offscreen", ctx, `${ctx.state}: ${m.what}`, `The ${m.kind} open in “${ctx.state}” (${m.what}) runs ${sentenceOff(m.off)} of the window.`), boxes);
    if (m.cut) await audit.picture(page, audit.add("covered", ctx, `${ctx.state}: ${m.what} is cut`, `The ${m.kind} open in “${ctx.state}” (${m.what}) is cut by a box that clips: ${m.cut.all ? "none of it shows" : `${m.cut.shows} of its ${m.cut.of} px show`}.`), boxes);
    if (m.covered.length) { const by = [...new Set(m.covered.map((c) => c.by))].slice(0, 2).join(", "); await audit.picture(page, audit.add("covered", ctx, `${ctx.state}: ${m.what} lies under ${by}`, `The ${m.kind} open in “${ctx.state}” (${m.what}) lies under ${by} at its ${m.covered.map((c) => c.where).join(", ")}.`), boxes); }
    if (m.rows && m.rows.odd.length) await audit.picture(page, audit.add("heights", ctx, `${ctx.state}: rows of ${m.what}`, `In the ${m.kind} open in “${ctx.state}”, rows are ${m.rows.usual}px tall but ${m.rows.odd.join(", ")}.`), boxes);
    if (m.rows && m.rows.n >= 2 && m.kind === "menu" && !ctx.variant) { const bag = audit.menus[ctx.surface] || (audit.menus[ctx.surface] = {}); const k2 = `${Math.round(m.rows.usual)}px rows, ${m.rows.font} type, row corner ${m.rows.radius}`; (bag[k2] = bag[k2] || []).length < 4 && !bag[k2].includes(ctx.state) && bag[k2].push(ctx.state); }
    if (opts.words !== false) { const w = await page.evaluate(narrowAudit, { scope: `[data-la-layer="${m.k}"]` }).catch(() => null);
      if (w) for (const [k, label] of [["broken", "is drawn on more than one line"], ["cut", "is cut with no “…”"], ["clipped", "(a button's own words) is cut"]]) for (const x of w[k]) await audit.picture(page, audit.add("cut", ctx, `${ctx.state}: “${x.text}” ${k}`, `In the ${m.kind} open in “${ctx.state}”, “${x.text}” ${label} (${x.what}).`), boxes); }
  }
  if (opts.inside) for (const m of res) await auditLayers(page, audit, ctx, { ...opts, scope: `[data-la-layer="${m.k}"]`, nested: false });
  await page.evaluate(() => { for (const n of window.__la.all("[data-la-layer]")) n.removeAttribute("data-la-layer"); window.__la.layers = []; }).catch(() => {});
}

/** The hover labels: each stays in the window, says its own control's words, and doesn't lie over them. */
export async function auditTips(page, audit, ctx, opts = {}) {
  await probe(page);
  const size = page.viewportSize(); ctx = { ...ctx, width: size.width, height: size.height };
  const hosts = await la(page, "tipHosts", { scope: opts.scope || "", most: opts.most || 12 });
  let warm = false;
  for (const h of hosts) {
    await la(page, "tipSnap");
    await page.mouse.move(h.x, h.y, { steps: 2 });
    const head = h.label.split("\n")[0].trim().replace(/\s+/g, " ");
    // Its own: the words of the control the pointer was put on, or of what is under the pointer now (a row's button drawn there on hover).
    const own = (t) => !!t && (t.underSays || t.text.startsWith(head.slice(0, 20)) || head.startsWith(t.text.slice(0, 20)));
    let tip = null; const until = Date.now() + (warm ? 500 : 1100) * PACE;
    while (Date.now() < until) { await page.waitForTimeout(warm ? 60 : 120); tip = await la(page, "tipNow", h.i).catch(() => null); if (tip) break; }
    if (!tip) { continue; }
    // (A label that is not this control's may be the last control's, late to go on a busy machine: what counts is the
    // label that is up once the page has had its time.)
    if (!own(tip)) { const late = Date.now() + 1200 * PACE; while (Date.now() < late) { await page.waitForTimeout(150); const now = await la(page, "tipNow", h.i).catch(() => null); if (!now) { tip = null; break; } tip = now; if (own(now)) break; } if (!tip) continue; }
    warm = true; audit.stats.tooltips++; audit.stats.layers++;
    const boxes = [{ rect: tip.host, colour: "blue", label: "pointed at" }, { rect: tip.rect, colour: "red", label: "label" }];
    if (Object.keys(tip.off).length) await audit.picture(page, audit.add("offscreen", ctx, `the label of “${head.slice(0, 40)}”`, `The hover label of “${head}” (${h.what}) runs ${sentenceOff(tip.off)} of the window.`), boxes);
    if (tip.overWords && !tip.underSays) await audit.picture(page, audit.add("covered", ctx, `the label of “${head.slice(0, 40)}” lies over its own words`, `The hover label of “${head}” (${h.what}) lies over that control's own words.`), boxes);
    if (!own(tip)) await audit.picture(page, audit.add("covered", ctx, `the label over “${head.slice(0, 40)}” is another control's`, `With the pointer on “${head}” (${h.what}) the label that shows says “${tip.text.slice(0, 60)}”: another control's.`), boxes);
  }
  await page.mouse.move(1, 1).catch(() => {}); await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => { for (const n of window.__la.all("[data-la-layer='tip']")) n.removeAttribute("data-la-layer"); }).catch(() => {});
}

/** The page at rest: words, the button family, controls of one row, controls off the side. */
export async function auditRest(page, audit, ctx, opts = {}) {
  await probe(page);
  const size = page.viewportSize(); ctx = { ...ctx, width: size.width, height: size.height };
  audit.stats.states++;
  const scope = opts.scope || "";
  const rest = await la(page, "rest", { scope });
  for (const m of rest.mates) await audit.picture(page, audit.add("heights", ctx, `${m.row}: ${m.a.split(" ")[0]} and ${m.b.split(" ")[0]}`, `In one row (${m.row}), ${m.a} and ${m.b}: ${m.problem}.`), [{ rect: { ...m.at, w: m.at.r - m.at.l, h: m.at.b - m.at.t }, colour: "red", label: m.problem }]);
  for (const f of rest.family) { const why = [f.badH ? `${f.h}px tall (the family is 28 or 22)` : "", f.badR ? `a ${f.radius}px corner (the family's is 6)` : ""].filter(Boolean).join(" and ");
    const g = audit.add("heights", ctx, `${f.what} is outside the button family`, `The button “${f.text}” (${f.what}, ${f.w}px wide) is ${why}${f.pill ? ": a pill" : ""}.`); await audit.picture(page, g, [{ rect: f.at, colour: "red", label: `${f.h}px, corner ${f.radius}` }]); }
  // Words that end in "…": the whole of them is said by a label the element carries, or by the hover label the page
  // draws when a pointer rests on them (asked of the page: the pointer rests there). One of each kind, a few a state.
  { const seen = new Set(); let asked = 0;
    for (const d of rest.dots) { if (seen.has(d.sig)) continue; seen.add(d.sig);
      const known = audit.found.get(`cut|${ctx.surface}|${d.sig} ends in “…” and nothing says the rest`), key = `${ctx.surface}|${d.sig}`;
      // (A kind of line that was asked once on this surface and said its words is not asked again.)
      let said = audit.says.has(key);
      // (A few are asked in a state, a label takes most of a second; one that was not asked here is asked at another size or state, not called a failure unasked.)
      if (!said && !known && (asked >= 6 || d.at.t < 0 || d.at.b > size.height)) continue;
      if (!said && !known) { asked++;
        await la(page, "tipSnap"); await page.mouse.move(d.at.l + Math.min(d.at.w / 2, 40), d.at.t + d.at.h / 2, { steps: 2 });
        const until = Date.now() + 2500 * PACE; while (Date.now() < until && !said) { await page.waitForTimeout(100); said = await page.evaluate((full) => window.__la.tipSays(full), d.text.slice(0, 24)).catch(() => false); }
        // (Not said: the page may still have been moving to its places when the line was measured. Where the line is
        // now is read again, and the pointer rests there once more.)
        if (!said) { await page.mouse.move(1, 1).catch(() => {}); await rested(page, 900, 300); const now = ((await la(page, "rest", { scope }).catch(() => null)) || { dots: [] }).dots.find((x) => x.sig === d.sig);
          if (!now) { said = true; } else { await la(page, "tipSnap"); await page.mouse.move(now.at.l + Math.min(now.at.w / 2, 40), now.at.t + now.at.h / 2, { steps: 3 }); const end = Date.now() + 3000 * PACE; while (Date.now() < end && !said) { await page.waitForTimeout(120); said = await page.evaluate((full) => window.__la.tipSays(full), now.text.slice(0, 24)).catch(() => false); } } }
        await page.mouse.move(1, 1).catch(() => {}); if (said) audit.says.add(key); }
      if (said) continue;
      await audit.picture(page, audit.add("cut", ctx, `${d.sig} ends in “…” and nothing says the rest`, `“${d.text}” ends in “…” (${d.shown} of ${d.needs}px show) in ${d.what}, and nothing says the whole of it: no label on it (title, data-tip, aria-label) and no hover label when a pointer rests on it.`), [{ rect: d.at, colour: "red", label: "…" }]); } }
  const w = await page.evaluate(narrowAudit, { scope }).catch(() => null);
  if (w) {
    for (const [k, label] of [["broken", "is drawn on more than one line"], ["cut", "is cut with no “…”"], ["clipped", "(a button's own words) is cut"]]) for (const x of w[k]) audit.add("cut", ctx, `“${x.text}” ${k} in ${x.what}`, `“${x.text}” ${label} in ${x.what}${x.by ? ` (by ${x.by}, ${x.hidden}px hidden)` : x.lines ? ` (${x.lines} lines in ${x.box}px)` : ""}.`);
    for (const x of w.sideways) if (!SCROLLS_ON_PURPOSE.test(x.what)) audit.add("cut", ctx, `${x.what} scrolls sideways`, `${x.what} has a sideways scrollbar of its own (${x.text}).`);
    for (const x of w.inner) audit.add("cut", ctx, `${x.what} scrolls by itself`, `A card on Home scrolls by itself: ${x.what} (${x.text}).`);
    if (w.page) audit.add("offscreen", ctx, "the page runs off sideways", "The page itself is wider than the window (it scrolls sideways).");
  }
  const read = await la(page, "read", { scope });
  for (const o of read.offside) audit.add("offscreen", ctx, `${o.what} is past the window's side`, `The control “${o.text}” (${o.what}) is drawn from ${o.left} to ${o.right}px in a window ${ctx.width}px wide.`);
  for (const o of read.over) audit.add("rows", ctx, `${o.a} and ${o.b} lie on each other`, `Two controls of one row lie on each other by ${o.by}px: “${o.aText}” (${o.a}) and “${o.bText}” (${o.b}).`);
  // What each kind of control measures here, for the comparison across surfaces.
  const bag = ctx.variant ? {} : audit.kinds[ctx.surface] || (audit.kinds[ctx.surface] = {});
  for (const [kind, looks] of Object.entries(rest.kinds)) { const k = bag[kind] || (bag[kind] = {}); for (const [look, who] of Object.entries(looks)) { k[look] = k[look] || []; for (const one of who) if (k[look].length < 4 && !k[look].includes(one)) k[look].push(one); } }
  return { rest, read };
}

/** la.read with the pointer away, then again with it resting on a row of each kind that keeps controls for a hover:
 *  an action counts as offered when either shows it. */
async function readAll(page, scope) {
  await page.mouse.move(1, 1).catch(() => {});
  const read = await la(page, "read", { scope }).catch(() => null); if (!read) return null;
  const rows = await la(page, "hoverRows", { scope, most: 1 }).catch(() => []);
  for (const h of rows.slice(0, 3)) { await page.mouse.move(h.x, h.y); await page.waitForTimeout(40);
    const again = await la(page, "read", { scope }).catch(() => null); if (!again) continue;
    for (const [key, a] of Object.entries(again.actions)) { const had = read.actions[key]; if (!had) read.actions[key] = { ...a, hover: true }; else if (a.ok && !had.ok) read.actions[key] = { ...a, hover: true }; else if (a.ok && had.faint && !a.faint) { had.faint = false; had.hover = true; } }
    for (const o of again.over) if (!read.over.some((x) => x.a === o.a && x.b === o.b)) read.over.push(o);
    for (const [key, r] of Object.entries(again.rows)) if (!read.rows[key]) read.rows[key] = r; }
  if (rows.length) await page.mouse.move(1, 1).catch(() => {});
  return read;
}
// One action under two wordings is one action: "Delete from your Library…" on a row and "Remove…" in its menu, "Open
// commands" on a bar and "Commands" in the Add menu. The shared actions by the icon walk's own reading of a name
// (support/uir2c-scene.mjs, ACTION_OF); the rest by their words, without the verb that only says "go there".
const actionOf = (0, eval)(ACTION_OF);
// (Pin and Unpin are one switch: a row's menu says the one its row is not.)
const forms = (w) => { const x = String(w || "").toLowerCase().replace(/[…:.]+$/g, "").replace(/\b(it|the|this|that|a|an)\b/g, " ").replace(/\s+/g, " ").trim(); const a = actionOf(String(w || "")); if (a) return [`@${a === "unpin" ? "pin" : a}`];
  const bare = x.replace(/^(open|show|view|see|go to)\s+/, "").trim(); return bare && bare !== x ? [x, bare] : [x]; };
const wordsOf = (x) => new Set(x.replace(/[^\p{L}\p{N}# ]+/gu, " ").split(" ").filter(Boolean));
export const sameAction = (want) => { const A = forms(want); return (w) => { const B = forms(w);
  for (const a of A) for (const b of B) { if (!a || !b) continue; if (a === b) return true; if (a.startsWith("@") || b.startsWith("@")) continue; if (b.length > 3 && a.length > 3 && (b.startsWith(a) || a.startsWith(b))) return true;
    // (a sentence said two ways: "Mark what is new as read. What needs you stays." and "Clear what is new here. What needs you stays.")
    const aw = wordsOf(a), bw = wordsOf(b); if (aw.size >= 5 && bw.size >= 5) { let both = 0; for (const x of aw) if (bw.has(x)) both++; if (both / (aw.size + bw.size - both) >= 0.5) return true; } }
  return false; }; };
const ranges = (widths) => { const s = [...widths].sort((a, b) => a - b), out = []; let from = s[0], prev = s[0]; for (const w of s.slice(1)) { if (w - prev > 61) { out.push(from === prev ? `${from}` : `${from}–${prev}`); from = w; } prev = w; } if (s.length) out.push(from === prev ? `${from}` : `${from}–${prev}`); return out.join(", "); };

/** The width sweep: the page at every width in `widths`, read at each (la.read) and compared with the widest. An action
 *  a row, bar or card offers at the widest must be reachable at every narrower width, by a control or by a menu of the
 *  same row; a row's height does not change with the width. `opts.words`: also audit the words at these widths. */
export async function sweep(page, audit, ctx, opts = {}) {
  await probe(page);
  const was = page.viewportSize(), widths = [...new Set(opts.widths)].sort((a, b) => b - a), scope = opts.scope || "";
  const height = opts.height || was.height;
  const reads = new Map();
  const log = { surface: ctx.surface, state: ctx.state, widths: widths.length, from: widths[widths.length - 1], to: widths[0], changes: [] };
  const missing = new Map(), heights = new Map();
  try {
    for (const width of widths) {
      // (A page that glides to its new places, as Home's cards do, is read once it has come to rest.)
      await page.setViewportSize({ width, height }); await rested(page, 900, opts.rest || 60);
      const c = { ...ctx, width, height };
      audit.stats.widths++;
      const read = await readAll(page, scope); if (!read) continue;
      reads.set(width, read);
      for (const o of read.offside) audit.add("offscreen", c, `${o.what} is past the window's side`, `The control “${o.text}” (${o.what}) is drawn from ${o.left} to ${o.right}px in a window ${width}px wide.`);
      for (const o of read.over) { const f = audit.add("rows", c, `${o.a} and ${o.b} lie on each other`, `Two controls of one row lie on each other by ${o.by}px: “${o.aText}” (${o.a}) and “${o.bText}” (${o.b}).`); if (!f.picture) { const rect = await la(page, "rectOf", o.a.split(" > ").pop()).catch(() => null); if (rect) await audit.picture(page, f, [{ rect, colour: "red", label: "overlap" }]); } }
      if (read.page) audit.add("offscreen", c, "the page runs off sideways", `The page itself is wider than the window by ${read.page}px (it scrolls sideways).`);
      if (opts.words && opts.words.includes(width)) { const w = await page.evaluate(narrowAudit, { scope }).catch(() => null);
        if (w) { for (const [k, label] of [["broken", "is drawn on more than one line"], ["cut", "is cut with no “…”"], ["clipped", "(a button's own words) is cut"]]) for (const x of w[k]) audit.add("cut", c, `“${x.text}” ${k} in ${x.what}`, `“${x.text}” ${label} in ${x.what}${x.by ? ` (by ${x.by}, ${x.hidden}px hidden)` : x.lines ? ` (${x.lines} lines in ${x.box}px)` : ""}.`);
          for (const x of w.sideways) if (!SCROLLS_ON_PURPOSE.test(x.what)) audit.add("cut", c, `${x.what} scrolls sideways`, `${x.what} has a sideways scrollbar of its own (${x.text}).`); } }
    }
    const widest = reads.get(widths[0]); if (!widest) return log;
    let prev = widest;
    for (const width of widths.slice(1)) {
      const read = reads.get(width); if (!read) continue;
      // What appears, disappears or changes height between this width and the one before (the log of the sweep).
      for (const key of new Set([...Object.keys(prev.actions), ...Object.keys(read.actions)])) { const a = !!prev.actions[key]?.ok, b = !!read.actions[key]?.ok; if (a !== b) log.changes.push(`${width}px: ${key} ${b ? "appears" : "goes"}`); }
      for (const key of new Set([...Object.keys(prev.rows), ...Object.keys(read.rows)])) { const a = prev.rows[key], b = read.rows[key]; if (a && b && (Math.abs(a.min - b.min) > 1 || Math.abs(a.max - b.max) > 1)) log.changes.push(`${width}px: row ${key} is ${b.min === b.max ? b.min : `${b.min}–${b.max}`}px tall (was ${a.min === a.max ? a.min : `${a.min}–${a.max}`})`); }
      prev = read;
      // (The same action under another holder at this width is the same action: a row grown tall, a button moved to another bar.)
      const offered = new Set(Object.values(read.actions).filter((x) => x.ok).map((x) => x.act));
      for (const [key, a] of Object.entries(widest.actions)) { if (!a.ok) continue; const now = read.actions[key]; if ((now && now.ok) || offered.has(a.act)) continue; if (!missing.has(key)) missing.set(key, { a, widths: [], why: now ? now.why : "not in the page" }); missing.get(key).widths.push(width); }
      // A row that grows at a narrower width because its words wrap, or its buttons go under its words, is in the log
      // above and is not a finding.
      // What counts: a row that is shorter at the narrower width with no fewer lines (a mark shrunk, a button's own
      // height gone), or whose height changes as it drops controls (the Library's rows, 16 Nov: the buttons went and
      // the row shrank).
      for (const [key, a] of Object.entries(widest.rows)) { const b = read.rows[key]; if (!b) continue; if ((b.h < a.h - 1 && b.lines >= a.lines) || (Math.abs(a.h - b.h) > 1 && b.shownControls < a.shownControls && b.lines <= a.lines)) { if (!heights.has(key)) heights.set(key, { a, at: [] }); heights.get(key).at.push([width, b]); } }
    }
    // An action that left its row: is it in a menu of that row at that width? (Asked at the narrowest width it is gone at.)
    for (const [key, m] of missing) {
      const width = Math.min(...m.widths);
      if (page.viewportSize().width !== width) { await page.setViewportSize({ width, height }); await rested(page, 900, 100); }
      const c = { ...ctx, width, height };
      const ownerSel = m.a.owner;
      let inMenu = false, tried = 0;
      const same = sameAction(m.a.act);
      // (the same action under another holder at this width: a bar that became a menu's row, a button moved to another bar)
      // (Read again here, at rest: on a busy machine the page may not have drawn itself at this width when the sweep passed.)
      await rested(page, 900, 300); const read = (await readAll(page, scope)) || reads.get(width);
      if (read.actions[key]?.ok) { log.changes.push(`${ranges(m.widths)}px: ${key} was late to be drawn`); continue; }
      const elsewhere = Object.values(read.actions).some((x) => x.ok && same(x.act));
      // One step away by the page's own way of folding at a narrow width (a Small card on Home opens whole): asked first
      // of a card, whose own controls are not menus to try.
      let reached = ""; if (!elsewhere && opts.reach && m.a.kind === "card") reached = await opts.reach(page, m.a, same).catch(() => "");
      if (!elsewhere && !reached && !(opts.reach && m.a.kind === "card")) {
        // The menus of that row or bar; and, where it has none, of the box it stands in (a bar's "…" may stand beside it).
        // Only what says it opens a menu, or is a "…": a control that unfolds or goes somewhere is not pressed here.
        let list = await la(page, "triggers", { scope: ownerSel, most: 1, menus: true }).catch(() => []);
        if (!list.length) list = await page.evaluate((sel) => { const L = window.__la, el = L.all(sel)[0]; if (!el) return []; let p = el.parentElement || (el.getRootNode().host || null); for (let n = 0; p && n < 2; n++) { p.setAttribute("data-la-scope", "1"); const got = L.triggers({ scope: "[data-la-scope='1']", most: 1, menus: true }); p.removeAttribute("data-la-scope"); if (got.length) return got; p = p.parentElement; } return []; }, ownerSel).catch(() => []);
        for (const t of list.slice(0, 4)) { const aim = await la(page, "aim", t.i); if (!aim || aim.gone) continue; tried++;
          await page.mouse.move(aim.x, aim.y); await settle(page, 30); await la(page, "snap");
          // (A control whose menu is on Shift+F10 is right-clicked: its plain press is its own action, a dock tile's goes to its Pip.)
          if (t.context) await page.mouse.click(aim.x, aim.y, { button: "right" }); else if (aim.hit) await page.mouse.click(aim.x, aim.y); else await la(page, "click", t.i); await rested(page, 400, 170);
          let r = await la(page, "opened", t.i).catch(() => null);
          // (A menu that has not come yet is given a moment more before it is called absent.)
          if (r && !r.layers.length && !r.disclosure) { await settle(page, 500); const late = await la(page, "opened", t.i).catch(() => null); if (late && late.layers.length) r = late; }
          const wordsNow = await la(page, "menuWords").catch(() => []);
          if (wordsNow.some(same)) inMenu = true;
          if (r && r.layers.length) { await page.keyboard.press("Escape"); await settle(page, 80); for (const l of r.layers) { const cl = await la(page, "closed", [l.k, t.i]).catch(() => ({ open: false })); if (cl.open) { await la(page, "forceClose", l.k); await page.mouse.click(2, 2).catch(() => {}); } } }
          else if (r && r.disclosure) { await la(page, "unmarkDisclosure"); const again = await la(page, "aim", t.i); if (again && !again.gone) await page.mouse.click(again.x, again.y).catch(() => {}); }
          if (inMenu) break; }
      }
      if (inMenu || elsewhere || reached) { log.changes.push(`${ranges(m.widths)}px: ${key} is ${elsewhere ? "offered elsewhere on the page" : inMenu ? "in the row's menu" : reached}`); continue; }
      const f = audit.add("unreachable", c, `${key}`, `“${m.a.act}” is offered by ${m.a.kind === "row" ? "a row" : m.a.kind === "card" ? "a card" : "a bar"} (${m.a.owner}) at ${widths[0]}px, and at ${ranges(m.widths)}px no control offers it (${m.why})${tried ? ` and none of the ${tried} menu${tried > 1 ? "s" : ""} there has it` : " and there is no menu there"}.`);
      const rect = await la(page, "rectOf", ownerSel).catch(() => null); if (rect) await audit.picture(page, f, [{ rect, colour: "red", label: `no “${m.a.act}” at ${width}px` }]);
    }
    for (const [key, h] of heights) {
      const said = h.at.map(([w, b]) => `${b.h}px at ${w}`).slice(0, 6).join(", ");
      const width = h.at[0][0]; const c = { ...ctx, width, height };
      const f = audit.add("rows", c, `row ${key} changes height with the width`, `The row ${key} is ${h.a.h}px tall at ${widths[0]}px and ${said}${h.at.length > 6 ? "…" : ""}, with its words on the same ${h.a.lines} line${h.a.lines === 1 ? "" : "s"} (changed at ${ranges(h.at.map(([w]) => w))}px).`);
      if (!f.picture) { await page.setViewportSize({ width, height }); await settle(page, 100); const rect = await la(page, "rectOf", key).catch(() => null); if (rect) await audit.picture(page, f, [{ rect, colour: "red", label: `${h.at[0][1].h}px at ${width} (${h.a.h} at ${widths[0]})` }]); }
    }
  } finally { await page.setViewportSize(was).catch(() => {}); await settle(page, 120); }
  log.changes = log.changes.slice(0, 80);
  audit.stats.sweeps.push(log);
  return log;
}

/** At a touch screen ((hover: none)): every action is in sight without a hover. */
export async function auditNoHover(page, audit, ctx, opts = {}) {
  await probe(page);
  const size = page.viewportSize(); ctx = { ...ctx, width: size.width, height: size.height, variant: "no hover" };
  const none = await page.evaluate(() => matchMedia("(hover: none)").matches);
  if (!none) { if (!audit.stats.notes.includes("this Chromium does not report (hover: none) for a touch screen")) audit.stats.notes.push("this Chromium does not report (hover: none) for a touch screen"); return false; }
  const read = await la(page, "read", { scope: opts.scope || "" });
  for (const [key, a] of Object.entries(read.actions)) if (a.ok && a.faint) { const f = audit.add("unreachable", ctx, `${key} needs a hover`, `On a screen with no hover, “${a.act}” (${a.kind} ${a.owner}) is not in sight: it is drawn only while a pointer rests on its ${a.kind}.`);
    const rect = await la(page, "rectOf", a.owner).catch(() => null); if (rect) await audit.picture(page, f, [{ rect, colour: "red", label: `“${a.act}” not in sight` }]); }
  return true;
}

/** A list scrolled to its end: its last row is in sight and under nothing (the dock, a bar that stays). */
export async function auditEnd(page, audit, ctx, opts = {}) {
  await probe(page);
  const size = page.viewportSize(); ctx = { ...ctx, width: size.width, height: size.height };
  // (The page was set to this size after the scene scrolled it: every list is put at its end again.)
  await page.evaluate(() => { for (const n of window.__la.all("*")) { const s = getComputedStyle(n); if (/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 24) n.scrollTop = n.scrollHeight; } });
  await settle(page, 160);
  const rows = await la(page, "lastRows", { scope: opts.scope || "" }).catch(() => []);
  for (const r of rows) { if (r.out) continue;
    await audit.picture(page, audit.add("covered", ctx, `the last row ${r.sig} lies under ${r.by}`, `With the list at its end, its last row (${r.sig}, “${r.text}”) lies under ${r.by}.`), [{ rect: r.rect, colour: "red", label: "last row" }]); }
}

// ---- the report -----------------------------------------------------------------------------------------------------
/** Entries of the allow-list that match a finding: [{ check, surface, what, reason }], `surface` and `what` as patterns. */
export const allowedBy = (f, allow) => allow.find((a) => a.check === f.check && new RegExp(a.surface).test(f.surface) && new RegExp(a.what).test(f.what)) || null;

/** Every part's findings as one report: report.json and report.md in OUT. Returns { findings, open, allowed, stats }. */
export function writeReport(allow = []) {
  mkdirSync(PARTS, { recursive: true });
  const parts = readdirSync(PARTS).filter((f) => /\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(PARTS, f), "utf8")));
  const findings = parts.flatMap((p) => p.findings.map((f) => ({ ...f, part: p.part })));
  for (const f of findings) { const a = allowedBy(f, allow); if (a) f.allowed = a.reason; }
  findings.sort((a, b) => RANK[a.check] - RANK[b.check] || a.surface.localeCompare(b.surface) || a.what.localeCompare(b.what));
  const open = findings.filter((f) => !f.allowed), allowed = findings.filter((f) => f.allowed);
  const sum = (k) => parts.reduce((n, p) => n + (p.stats[k] || 0), 0);
  const stats = { layers: sum("layers"), menus: sum("menus"), dialogs: sum("dialogs"), tooltips: sum("tooltips"), disclosures: sum("disclosures"), triggers: sum("triggers"), nested: sum("nested"), keyboard: sum("keyboard"), widths: sum("widths"), states: sum("states"), pictures: sum("pictures"),
    distinct: new Set(parts.flatMap((p) => Object.keys(p.stats.opened || {}))).size, seconds: parts.reduce((n, p) => n + (p.stats.seconds || 0), 0) };
  const json = { at: new Date().toISOString(), stats, open: open.length, allowed: allowed.length, findings, parts: parts.map((p) => ({ part: p.part, at: p.at, stats: { ...p.stats, opened: undefined, sweeps: undefined }, opened: p.stats.opened, sweeps: p.stats.sweeps, unopened: p.stats.unopened, notes: p.stats.notes, table: p.table, missing: p.missing })) };
  const tmp = join(OUT, `.report-${process.pid}.json`); writeFileSync(tmp, JSON.stringify(json, null, 1)); renameSync(tmp, join(OUT, "report.json"));
  const md = [];
  md.push("# DGC layout audit", "", `Run ${json.at}. Real Chromium, the real pages (the scenes the tests use).`, "",
    `**${open.length} finding${open.length === 1 ? "" : "s"} open**, ${allowed.length} left on purpose (each with its reason, at the end).`, "",
    `Opened and measured: **${stats.layers} layers** (${stats.menus} menus and popovers, ${stats.dialogs} dialogs, ${stats.tooltips} hover labels) from ${stats.triggers} presses of ${stats.distinct} different controls, ${stats.nested} of them a menu inside a menu or a dialog, ${stats.keyboard} opened again by the keyboard; ${stats.disclosures} things unfolded in place. ${stats.states} page states read at rest; ${stats.widths} page widths read in the sweeps. ${stats.pictures} pictures.`, "");
  md.push("| | check | open | left on purpose |", "|---|---|---|---|");
  CHECKS.forEach(([id, title], i) => md.push(`| ${i + 1} | ${title} | ${open.filter((f) => f.check === id).length} | ${allowed.filter((f) => f.check === id).length} |`));
  md.push("");
  const line = (f) => `- **${f.surface}**: ${f.says}  \n  _Seen at:_ ${f.at.slice(0, 5).join("; ")}${f.at.length > 5 ? `; and ${f.at.length - 5} more` : ""}.${f.picture ? `  \n  ![](${f.picture})` : ""}`;
  for (const [id, title, what] of CHECKS) { const list = open.filter((f) => f.check === id); if (!list.length) continue; md.push(`## ${title} (${list.length})`, "", what, "", ...list.map(line), ""); }
  if (!open.length) md.push("## Nothing open", "", "Every check passed on every surface.", "");
  if (allowed.length) { md.push(`## Left on purpose (${allowed.length})`, ""); for (const f of allowed) md.push(`- **${f.surface}** (${f.check}): ${f.says}  \n  _Why it stays:_ ${f.allowed}`); md.push(""); }
  md.push("## The sizes, and what is sampled", "", ...SAMPLING, "");
  md.push("## What was walked", "");
  for (const p of json.parts) { md.push(`### ${p.part}`, "", `${p.stats.layers} layers (${p.stats.menus} menus, ${p.stats.dialogs} dialogs, ${p.stats.tooltips} labels), ${p.stats.states} states at rest, ${p.stats.widths} widths swept, ${Math.round(p.stats.seconds || 0)} s.`, "");
    const opened = Object.entries(p.opened || {}); if (opened.length) md.push("<details><summary>The layers it opened</summary>", "", ...opened.map(([k, n]) => `- ${k} (${n}×)`), "", "</details>", "");
    if ((p.unopened || []).length) md.push("<details><summary>Controls that say they open something (aria-haspopup) and opened no layer here</summary>", "", ...[...new Set(p.unopened.map((u) => u.replace(/ \d+px:/, ":")))].slice(0, 60).map((u) => `- ${u}`), "", "</details>", "");
    for (const s of p.sweeps || []) md.push(`<details><summary>Sweep: ${s.surface}, ${s.state}: ${s.widths} widths from ${s.from} to ${s.to}px, ${s.changes.length} changes</summary>`, "", ...s.changes.map((c) => `- ${c}`), "", "</details>", "");
    if ((p.notes || []).length) md.push("Notes:", ...[...new Set(p.notes)].slice(0, 30).map((n) => `- ${n}`), "");
    if (p.table) { md.push("#### One kind of control, on every surface", "", "What each kind measures, and where (a menu's rows and a field are held to one look: a second one is a finding above; buttons with words are held to the family by the heights check; the rest is here to be read).", "");
      for (const [kind, looks] of Object.entries(p.table)) { md.push(`**${kind === "menus" ? "a menu's rows" : kind}**`, ""); for (const [look, where] of Object.entries(looks).sort((a, b) => b[1].length - a[1].length)) md.push(`- ${look}: ${where.length} surface${where.length > 1 ? "s" : ""} (${where.slice(0, 6).map((w) => `${w.surface}: ${w.who.slice(0, 2).join(", ")}`).join("; ")}${where.length > 6 ? "; …" : ""})`); md.push(""); } } }
  writeFileSync(join(OUT, "report.md"), md.join("\n"));
  return { findings, open, allowed, stats, parts: json.parts };
}
export const clearPart = (part) => { rmSync(join(PARTS, `${part}.json`), { force: true }); if (existsSync(PICTURES)) for (const f of readdirSync(PICTURES)) if (f.includes(`-${part}-`)) rmSync(join(PICTURES, f), { force: true }); };
export { settle, rested, probe, la };
