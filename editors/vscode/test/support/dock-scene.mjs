// The side bar's home with its dock (media/shared/dock.js, media/shared/blob.js), in real Chromium on the real page
// (home-scene.mjs opens it). A small stand-in for the host keeps what is pinned and each session's colour the way
// src/dock.ts does and answers every dock message with the dock's state, so a pin on a row, a move, a colour or a
// setting shows as it would in the editor. Shared by dock.test.mjs and the pictures. Not a *.test.mjs file.
import { openHome, pipId, SESSIONS, CHATS } from "./home-scene.mjs";
import { host as pipHost, PIP } from "./pip-chat-scene.mjs";

export { pipId, PIP };
/** Sessions for the dock: one open in a tab, one running in its tab, one wanting your okay, one at rest. */
export const DOCK_SESSIONS = [
  { ...SESSIONS[0], name: "Fix the login redirect after sign-out", open: true, running: true },
  { ...SESSIONS[1], name: "Write about 120 words on why tide pools matter", open: true },
  { ...SESSIONS[2], name: "Plan the 0.52 release notes", waiting: true },
  { ...SESSIONS[3] },
];
const pin = (kind, id, title, more = {}) => ({ key: `${kind}:${id}`, kind, id, title, sub: "", look: {}, ref: {}, ...more });
/** What is pinned in most pictures: three Pips (one waits for you), two Work sessions (one runs, one is open), a chat. */
export const PINS = [
  pin("pip", pipId("b"), "Mail watch", { look: { body: "scout" } }),
  pin("pip", pipId("c"), "Morning brief", { look: { body: "quill" } }),
  pin("pip", pipId("d"), "Garden notes", { look: { body: "lens" } }),
  pin("work", DOCK_SESSIONS[0].id, DOCK_SESSIONS[0].name),
  pin("work", DOCK_SESSIONS[1].id, DOCK_SESSIONS[1].name),
  pin("chat", CHATS[0].id, CHATS[0].title),
];
/** A page, a sheet and a widget from the Library. */
export const LIBRARY_PINS = [
  pin("artifact", "ar_" + "1".repeat(16), "Tide pool walk, Saturday", { sub: "Page · version 1", look: { type: "page" } }),
  pin("artifact", "ar_" + "2".repeat(16), "Acme sales sheet", { sub: "Sheet · version 4", look: { type: "sheet" } }),
  pin("file", "att_" + "3".repeat(32), "Billing review.pdf", { sub: "PDF · in “Rent or buy”", look: { type: "pdf" } }),
  pin("widget", "wg_" + "4".repeat(16), "Weekly signups", { sub: "Widget · in “Growth”" }),
];
/** `n` pins: the six above, then more sessions and chats. */
export function manyPins(n) {
  const more = Array.from({ length: Math.max(0, n - PINS.length) }, (_, i) => (i % 2 ? pin("chat", `chat_more_${i}`, `Chat number ${i}`) : pin("work", `2026-more-${i}`, `Session number ${i}`)));
  return [...PINS, ...more].slice(0, n);
}

/** Opens the side bar with a dock, on its Work tab (tab: another). pins: what is pinned; pip: what the Pips view's own Pip is (pip-chat-scene's options); show: "always" | "hover" | "never"; most, size: the Dock settings;
 *  colours: {"work:<id>": 1..7}. Everything else is home-scene's (width, height, theme, state, motion, srcRoot...). */
export async function openDock(browser, { pins = PINS, show = "always", most = 8, size = 34, colours = {}, sessions = DOCK_SESSIONS, answering = [], dock = true, tab = "work", ...home } = {}) {
  // (On the Work tab unless a test says another: the rows with their pins are there.)
  const x = await openHome(browser, { sessions, tab, ...home });
  await x.page.evaluate((initial) => {
    const state = window.__dock = { ...initial };
    window.__asked = [];
    const say = () => window.dispatchEvent(new MessageEvent("message", { data: JSON.parse(JSON.stringify({ type: "dock", ...state })) }));
    const pinOf = (item) => ({ key: `${item.kind}:${item.id}`, kind: item.kind, id: item.id, title: item.title, sub: item.sub || "", look: item.look || {}, ref: item.ref || {} });
    const host = (m) => {
      if (!m || typeof m.type !== "string" || !m.type.startsWith("dock")) return;
      const at = (key) => state.pins.findIndex((p) => p.key === key);
      if (m.type === "dockToggle" || m.type === "dockPin") {
        const next = pinOf(m.item), had = at(next.key);
        if (had >= 0 && m.type === "dockToggle") state.pins.splice(had, 1);
        else if (had < 0) {
          // At its most, the editor asks which to take off; here the first goes, and the question is noted.
          if (state.pins.length >= state.most) { window.__asked.push({ for: next.title, most: state.most, offered: state.pins.map((p) => p.title) }); state.pins.shift(); }
          state.pins.push(next);
        }
      } else if (m.type === "dockUnpin") { if (at(m.key) >= 0) state.pins.splice(at(m.key), 1); }
      else if (m.type === "dockMove") { const a = at(m.key), b = a + (m.by < 0 ? -1 : 1); if (a >= 0 && b >= 0 && b < state.pins.length) [state.pins[a], state.pins[b]] = [state.pins[b], state.pins[a]]; }
      else if (m.type === "dockColour") { if (Number.isInteger(m.colour)) state.colours[m.key] = m.colour; else delete state.colours[m.key]; }
      else if (m.type === "dockSeen") { for (const item of m.items || []) { const p = state.pins[at(item.key)]; if (p) p.title = item.title; } }
      say();
    };
    // Everything the page posts is noted (home-scene), and a dock message is answered as the host answers it.
    const posted = window.__posted;
    posted.push = function (m) { Array.prototype.push.call(this, m); try { host(m); } catch (error) { window.__dockError = String(error); } return this.length; };
    window.__dockSay = (change) => { Object.assign(state, change); say(); };
    say();
  }, { pins, colours, show, most, size });
  // The Pips view on this page (Open Pips, a pinned Pip): its requests are answered as pip-chat-scene.mjs answers them.
  await x.page.evaluate((script) => {
    const real = window.acquireVsCodeApi;
    (0, eval)(script);
    const pips = window.acquireVsCodeApi(); window.acquireVsCodeApi = real;
    window.__pipsApp = (m) => pips.postMessage(m);
  }, pipHost({ api: 78, ...(home.pip || {}) }));
  if (answering.length) await x.send({ type: "chatdgc_list", available: true, items: CHATS, open: ["chat_1"], answering });
  const setting = (change) => x.page.evaluate((c) => window.__dockSay(c), change);
  const settle = () => x.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)))));
  // (dock: false is a tree from before the dock, for a "before" picture.)
  if (dock) await x.page.waitForFunction((s) => s === "never" || !!document.querySelector("#dgc-dock .dgc-dock-item"), show, { timeout: Number(process.env.DGC_DOCK_WAIT_MS) || 30000 });
  await settle();
  return { ...x, setting, settle };
}

/** The dock as it is on screen: its bar, each item (size, where, name, dot, number), its name tip, and the page above. */
export const dockNow = (page) => page.evaluate(() => {
  const host = document.getElementById("dgc-dock"), rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  if (!host) return null;
  const shown = host.checkVisibility(), bar = host.querySelector(".dgc-dock-bar"), tip = host.querySelector(".dgc-dock-tip");
  const items = [...host.querySelectorAll(".dgc-dock-item")].map((b) => ({ key: b.dataset.key || "+", kind: b.dataset.kind || "add", label: b.getAttribute("aria-label"), tab: b.tabIndex,
    ...rect(b), dot: b.querySelector(".dgc-dock-dot")?.dataset.dot || "", badge: b.querySelector(".dgc-dock-badge")?.textContent || "",
    blob: b.querySelector(".dgc-blob") ? { shape: b.querySelector(".dgc-blob").dataset.shape, pair: Number(b.querySelector(".dgc-blob").dataset.pair), running: b.querySelector(".dgc-blob").hasAttribute("data-running") } : null,
    holds: b.querySelector(".dgc-blob") ? "blob" : b.querySelector(".dgc-cube") ? "cube" : b.querySelector(".dgc-sheet") ? "sheet" : b.querySelector(".dgc-dock-face svg, .dgc-dock-face > *") ? "face" : b.querySelector(".dgc-dock-plus") ? "plus" : "" }));
  const page = [...document.body.children].find((n) => n.id === "sessions-host" && n.checkVisibility()) || [...document.body.children].find((n) => n.id === "pips-host" && n.checkVisibility());
  const active = document.activeElement;
  return { shown, show: host.dataset.show, state: host.dataset.state, up: host.hasAttribute("data-up"), host: rect(host), bar: rect(bar), items,
    barOpacity: Number(getComputedStyle(bar).opacity),
    tip: tip.hidden ? null : { title: tip.querySelector("b").textContent, state: tip.querySelector("span").textContent, ...rect(tip) },
    page: page ? { id: page.id, ...rect(page) } : null, width: innerWidth, height: innerHeight,
    overflowX: document.documentElement.scrollWidth > innerWidth,
    focus: active?.dataset?.key || (active?.dataset?.add ? "+" : active?.dataset?.id || active?.dataset?.colour || active?.id || active?.className || ""),
    menu: [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].map((r) => r.textContent.trim() + (r.disabled ? " (off)" : "")),
    swatches: [...document.querySelectorAll(".dgc-pop .dgc-swatch")].map((s) => ({ pair: Number(s.dataset.colour), on: s.getAttribute("aria-checked") === "true", shape: s.dataset.shape })) };
});

/** Every word and mark of the dock, its name tip, its menu and the rows' pins, as painted: [{what, kind, ink, ground}]. */
export const dockContrast = (page) => page.evaluate(() => {
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const out = [], add = (what, kind, ink, e) => { const g = ground(e); out.push({ what, kind, ink: over(parse(ink), g).slice(0, 3), ground: g.slice(0, 3) }); };
  const dock = document.getElementById("dgc-dock"), css = (e, p) => getComputedStyle(e, p);
  for (const e of dock.querySelectorAll(".dgc-dock-tip b, .dgc-dock-tip span, .dgc-dock-empty")) if (e.checkVisibility() && e.textContent) add(`${e.parentElement.className} ${e.tagName.toLowerCase()}`, "words", css(e).color, e);
  for (const e of dock.querySelectorAll(".dgc-dock-badge")) out.push({ what: "badge number", kind: "words", ink: parse(css(e).color).slice(0, 3), ground: parse(css(e).backgroundColor).slice(0, 3) });
  for (const e of dock.querySelectorAll(".dgc-dock-badge")) add("badge on the bar", "mark", css(e).backgroundColor, e.closest(".dgc-dock-bar"));
  for (const e of dock.querySelectorAll(".dgc-dock-dot")) add(`dot ${e.dataset.dot}`, "mark", css(e).backgroundColor, e.closest(".dgc-dock-bar"));
  for (const e of dock.querySelectorAll(".dgc-dock-plus")) add("plus", "mark", css(e).color, e);
  const hint = dock.querySelector(".dgc-dock-hint"); if (hint.checkVisibility()) add("the short line", "mark", css(hint).backgroundColor, document.body);
  for (const e of document.querySelectorAll(".dgc-pop .dgc-menu-label, .dgc-pop .dgc-menu-head span")) add(`menu ${e.textContent.trim()}`, "words", css(e).color, e);
  for (const e of document.querySelectorAll(".dgc-pop .dgc-pop-icon")) add("menu icon", "mark", css(e).color, e);
  for (const e of document.querySelectorAll(".dgc-pop .dgc-swatch[aria-checked='true']")) add("chosen colour's ring", "mark", css(document.querySelector(".dgc-pop .dgc-menu-label")).color, e);
  for (const e of document.querySelectorAll("#sessions-host .dgc-pin, #sessions-host .session-more")) if (e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) add(`row ${e.className.split(" ")[0]} ${e.getAttribute("aria-pressed") || ""}`, "mark", css(e).color, e);
  return out;
});
