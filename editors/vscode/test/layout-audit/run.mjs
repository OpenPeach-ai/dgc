// The layout audit's run: every page in the plan (surfaces.mjs), in every pass, a few at a time in one browser. Returns
// the Audit with what it found. Not a *.test.mjs file.
import { cpus } from "node:os";
import { Audit, auditLayers, auditOpen, auditTips, auditRest, auditEnd, auditNoHover, sweep, settle, rested, pace, clearPart } from "./harness.mjs";
import { SCENES, PLAN, PASSES, SPLIT, SWEEP, SWEEP_SAMPLED, SWEEP_WORDS, EXTRA } from "./surfaces.mjs";
import { consistency } from "./consistency.mjs";
import { walkGlyphs, glyphFaults, sizeFaults } from "../support/icon-walk.mjs";

const DONE = new Error("every state is measured");
const FULL = process.env.DGC_LAYOUT_SWEEP === "full";
// Pages walked at once: each is its own page in the one browser. Half the machine's processors, ten at the most.
const POOL = Math.max(2, Math.min(10, Math.floor(cpus().length / 2)));

/** One page of the plan in one pass (and, for a page that is the side bar or a tab by its width, one of the two). */
async function job(browsers, audit, entry, passKey, splitKey) {
  const pass = PASSES[passKey];
  let open = pass.open, sizes = pass.sizes;
  if (entry.split) { const sp = SPLIT[splitKey]; open = sp.open; sizes = pass.first ? sp.sizes : pass.sizes.filter(([w]) => (splitKey === "side") === (w < 600)); if (!sizes.length) sizes = [[sp.open, pass.sizes[0][1]]]; }
  if (entry.fixed) open = entry.fixed;
  if (entry.widths && pass.first) sizes = entry.widths.map((w) => [w, 760]);
  const left = entry.states ? new Set(Object.keys(entry.states)) : null, seen = [];
  const visit = async (state, page, o = {}) => {
    const planned = entry.states ? entry.states[state] : entry.ops;
    if (!planned) return;
    const was = page.viewportSize();
    audit.stats.pages++;
    audit.stats.pace = Math.max(audit.stats.pace || 1, Math.round((await pace(page)) * 10) / 10);
    // A state that is a layer the scene opened itself is measured at the size it was opened at: a window that changes
    // size closes a menu, and the scene's next step needs it open.
    const held = ![...planned].some((c) => "LRSsTEH".includes(c));
    if (held && passKey === "C") { seen.push(state); if (left) { left.delete(state); if (!left.size) throw DONE; } return; }
    const sizesHere = held ? [[was.width, was.height]] : sizes;
    // The view this state is: the side bar's chosen tab, and whether it is inside the Pips view. A press that goes
    // somewhere else (it should not: the walk presses what opens a layer) is undone by choosing that tab again, and
    // said in the report's notes; where it can't be undone the state's walk stops, so nothing is measured on another page.
    const view = () => page.evaluate(() => `${document.querySelector("#side-tabs [role='tab'][aria-selected='true']")?.id || ""}|${["sessions-active", "pips-active", "inside-pip"].filter((c) => document.body.classList.contains(c)).join(" ")}`).catch(() => "");
    const home = await view();
    const stay = async (after) => { if (!home || home === "|") return true; const now = await view(); if (now === home) return true;
      audit.stats.notes.push(`${entry.name}, ${state}: the walk left the view after ${after} (${home} became ${now}); put back`);
      const tab = home.split("|")[0]; if (tab) { await page.keyboard.press("Escape").catch(() => {}); await page.evaluate((id) => document.getElementById(id)?.click(), tab).catch(() => {}); await rested(page, 900, 300); }
      return (await view()) === home; };
    try {
      const modes = pass.fonts ? pass.fonts.map((f) => ({ font: f })) : pass.forced ? [{ forced: true }, { contrast: true }] : [{}];
      for (const mode of modes) for (let n = 0; n < sizesHere.length; n++) {
        const [width, height] = sizesHere[n], first = !!pass.first && n === 0;
        let ops = [...planned].filter((c) => (pass.only ? pass.only.includes(c) : c !== "H") && (first || pass.only || "LROE".includes(c))).join("");
        // (I presses keys that may close the scene's own layer: once, at the first size.)
        if (planned.includes("I") && !first) continue;
        if (!ops) continue;
        if (!held) await page.setViewportSize({ width, height });
        let style = null;
        if (mode.font) style = await page.addStyleTag({ content: `html:root, html body { --vscode-font-size: ${mode.font}px; } html:root { font-size: ${mode.font}px; }` }).catch(() => null);
        if (mode.forced) await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
        if (mode.contrast) await page.evaluate(() => { document.body.classList.remove("vscode-dark"); document.body.classList.add("vscode-high-contrast"); });
        // (Until the page has come to rest at its new size: Home's cards glide to their places.)
        await rested(page, 900, 160);
        const ctx = { surface: entry.name, state, theme: pass.theme, variant: mode.font ? `font ${mode.font}px` : mode.forced ? "forced colours, reduced motion" : mode.contrast ? "high contrast" : pass.variant || "" };
        const scope = o.scope || "";
        // (The second mode of a pass, a smaller font or the high-contrast class, changes no place of a layer: the page at rest only.)
        if (mode !== modes[0]) ops = [...ops].filter((c) => c === "R").join("");
        const timed = async (key, fn) => { const t = Date.now(); try { await fn(); } finally { audit.stats.ms[key] = (audit.stats.ms[key] || 0) + Date.now() - t; } };
        try {
          if (entry.prepare) await entry.prepare(page);
          if (!(await stay("the size was set"))) break;
          if (ops.includes("R")) await timed("rest", () => auditRest(page, audit, ctx, { scope }));
          if (ops.includes("O") || ops.includes("I")) await timed("open", () => auditOpen(page, audit, ctx, { inside: ops.includes("I"), keyboard: first }));
          // (A short or tall window, and forced colours, move a layer or repaint it; its words and what is inside it are read in the other passes.)
          if (ops.includes("L")) await timed("layers", () => auditLayers(page, audit, ctx, { scope, stay, keyboard: first && planned.includes("K"), extra: first || passKey === "C" ? EXTRA[entry.extra] || [] : [], ...(passKey === "C" || passKey === "E" ? { words: false, nested: false } : {}) }));
          if (!(await stay("the layers"))) break;
          if (ops.includes("T")) await timed("labels", () => auditTips(page, audit, ctx, { scope }));
          if (!(await stay("the hover labels"))) break;
          if (ops.includes("E")) await timed("end", () => auditEnd(page, audit, ctx, { scope }));
          if (ops.includes("S") || ops.includes("s")) await timed("sweep", () => sweep(page, audit, ctx, { scope, widths: ops.includes("S") || FULL ? SWEEP : SWEEP_SAMPLED, words: SWEEP_WORDS, height, reach: entry.reach }));
          if (!(await stay("the sweep"))) break;
          if (ops.includes("H")) await timed("no hover", () => auditNoHover(page, audit, ctx, { scope }));
        } finally {
          if (style) await style.evaluate((n) => n.remove()).catch(() => {});
          if (mode.forced) await page.emulateMedia({ forcedColors: "none", reducedMotion: null }).catch(() => {});
          if (mode.contrast) await page.evaluate(() => { document.body.classList.remove("vscode-high-contrast"); document.body.classList.add("vscode-dark"); }).catch(() => {});
        }
      }
    } finally {
      // The page goes back to the scene as it was handed over: its size, nothing of the walk's left open, the pointer away.
      // (Only where the walk pressed things: Escape in a state that is the scene's own dialog would close it under the scene.)
      // (No key is pressed for it: Escape in an opened card of Home goes back to Home, under the scene.)
      if ([...planned].some((c) => "LTSs".includes(c))) await page.evaluate(() => { window.__la?.closeLeft?.(); if (window.DgcBlob?.isOpen?.()) window.DgcBlob.close(); }).catch(() => {});
      if (!held) await page.mouse.move(1, 1).catch(() => {});
      if (was && !held) await page.setViewportSize(was).catch(() => {}); await settle(page, 120); }
    seen.push(state);
    if (left) { left.delete(state); if (!left.size) throw DONE; }
  };
  try { await SCENES[entry.scene](pass.touch ? browsers.touch : browsers.plain, { width: open, theme: pass.theme, touch: !!pass.touch }, visit); }
  catch (error) { if (error !== DONE) audit.stats.notes.push(`${entry.name}, pass ${passKey}${splitKey ? " " + splitKey : ""}: the scene stopped: ${String(error.message || error).split("\n")[0].slice(0, 200)}`); }
  return seen;
}

/** Runs the plan. opts: { only: a pattern of scene names, passes: "ABCDEF", pool, part }. */
export async function runAudit(browser, opts = {}) {
  const audit = new Audit(opts.part || "all"), t0 = Date.now();
  clearPart(audit.part);
  const touch = new Proxy(browser, { get(target, key) {
    if (key === "newContext") return (o = {}) => target.newContext({ ...o, hasTouch: true });
    if (key === "newPage") return (o = {}) => target.newPage({ ...o, hasTouch: true });
    const v = target[key]; return typeof v === "function" ? v.bind(target) : v; } });
  const browsers = { plain: browser, touch };
  const only = opts.only ? new RegExp(opts.only) : null, jobs = [], visited = new Map();
  for (const entry of PLAN) { if (only && !only.test(entry.scene)) continue;
    for (const p of [...(entry.passes || "ABCDEF")]) { if (opts.passes && !opts.passes.includes(p)) continue;
      // (the touch pass has work only where a state asks for H)
      if (p === "F" && !(entry.states ? Object.values(entry.states).some((s) => s.includes("H")) : (entry.ops || "").includes("H"))) continue;
      for (const sk of entry.split ? ["side", "tab"] : [""]) jobs.push({ entry, p, sk }); } }
  // The long jobs first, so the pool ends together.
  jobs.sort((a, b) => (b.p === "A") - (a.p === "A"));
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const j = jobs[next++], t = Date.now(); const seen = await job(browsers, audit, j.entry, j.p, j.sk);
    if (!visited.has(j.entry.scene)) visited.set(j.entry.scene, new Set()); for (const s of seen) visited.get(j.entry.scene).add(s);
    if (process.env.DGC_LAYOUT_AUDIT_LOG) console.error(`  ${j.entry.scene} ${j.p}${j.sk ? " " + j.sk : ""}: ${((Date.now() - t) / 1000).toFixed(1)} s, ${seen.length} states`); } };
  await Promise.all(Array.from({ length: Math.max(1, Number(process.env.DGC_LAYOUT_AUDIT_POOL) || opts.pool || POOL) }, worker));
  // A state the plan names and no pass showed: the plan is out of date.
  audit.missing = [];
  for (const entry of PLAN) { if (only && !only.test(entry.scene)) continue; if (!entry.states) continue; const got = visited.get(entry.scene) || new Set(); for (const s of Object.keys(entry.states)) if (!got.has(s) && !audit.missing.includes(`${entry.scene}: ${s}`)) audit.missing.push(`${entry.scene}: ${s}`); }
  if (!only) consistency(audit);
  // One action, one icon: the walk uir2c-icons.test.mjs holds the rule with, read here for the report.
  if (!only || only.test("icons")) { try { const found = await walkGlyphs(browser), ctx = { surface: "every surface", state: "the icon walk", width: 0, height: 0, theme: "dark" };
    for (const line of glyphFaults(found).off) audit.add("icons", ctx, line.split(" at ")[0], `One action, two glyphs: ${line}.`);
    for (const line of sizeFaults(found)) audit.add("icons", ctx, line, `A glyph at another size than its kind's: ${line}.`);
    audit.stats.glyphs = found.length; } catch (error) { audit.stats.notes.push(`the icon walk stopped: ${String(error.message || error).split("\n")[0].slice(0, 200)}`); } }
  audit.stats.seconds = Math.round((Date.now() - t0) / 1000);
  audit.stats.jobs = jobs.length;
  return audit;
}
