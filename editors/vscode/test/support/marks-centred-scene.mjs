// Every place a mark sits beside words (Mote, Voxel, Folio, Portal from media/shared/marks.js; the file sheet from
// media/shared/filesheet.js), opened one after the other in real Chromium, for marks-centred-browser.test.mjs and its
// before/after pictures. Not a test file.
//
// The rule measured: a mark's vertical centre is the vertical centre of the block of words beside it (both lines of a
// two-line row); a mark alone in a tile or a swatch is centred in it.
import { openDock, LIBRARY_PINS } from "./dock-scene.mjs";
import { CHATS } from "./home-scene.mjs";
import { openChat as openChatDgc, openLibrary, conversation, ITEMS, OFFER, M } from "./chat-scene.mjs";
import { openWorkTab } from "./work-tab-scene.mjs";
import { openChat as openPipChat } from "./pip-chat-scene.mjs";
import { openComputer, PIP } from "./pip-computer-scene.mjs";

/** Runs in the page: every mark in sight under `scope`, with how far its centre is from the words beside it. */
export const measure = ([scope, mode]) => {
  const root = window.__pipsRoot || document;
  const MARKS = ".mote, .voxel, .folio, .portal, .dgc-sheet";
  const seen = (n) => n.getClientRects().length > 0 && n.checkVisibility({ visibilityProperty: true }) && n.getBoundingClientRect().width > 0.5;
  const lines = (el, own = false) => {
    const out = [], walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = walk.nextNode());) {
      const p = n.parentElement;
      if (!n.textContent.trim() || !p || (own && p !== el) || !seen(p) || p.closest(MARKS) || p.closest(".sr-only, [hidden], [aria-hidden=true]:not(svg)") && !own) continue;
      const style = getComputedStyle(p);
      if (style.position === "absolute" && (parseFloat(style.width) <= 1 || style.clip !== "auto" || style.clipPath !== "none")) continue;   // read aloud only
      // The lines the words stand on: a block of text's own box inside its padding (its line boxes, so two lines of
      // different sizes are measured by their lines, not their letters); words set inline, by their own boxes.
      if (!style.display.startsWith("inline") && !own) {
        const r = p.getBoundingClientRect(), top = r.top + parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth), bottom = r.bottom - parseFloat(style.paddingBottom) - parseFloat(style.borderBottomWidth);
        if (bottom - top > 0.5) out.push({ top, bottom, left: r.left, right: r.right, width: r.width, height: bottom - top });
        continue;
      }
      const range = document.createRange(); range.selectNodeContents(n);
      out.push(...[...range.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5));
    }
    return out;
  };
  const span = (rects) => (rects.length ? { top: Math.min(...rects.map((r) => r.top)), bottom: Math.max(...rects.map((r) => r.bottom)) } : null);
  const name = (n) => n.tagName.toLowerCase() + (n.id ? "#" + n.id : "") + (typeof n.className === "string" && n.className ? "." + n.className.trim().split(/\s+/).slice(0, 2).join(".") : "");
  const found = [];
  for (const box of root.querySelectorAll(scope)) for (const mark of box.querySelectorAll(MARKS)) {
    if (!seen(mark) || mark.parentElement.closest(MARKS)) continue;
    const m = mark.getBoundingClientRect(), mid = (m.top + m.bottom) / 2;
    const row = { mark: mark.className.split(" ")[0], size: Math.round(m.height), mid: Math.round(mid * 10) / 10 };
    row.at = [Math.round(m.left), Math.round(m.top), Math.round(m.right), Math.round(m.bottom)];
    if (mode === "tile") {
      const tile = mark.closest("button, [role=button], [role=menuitemradio], a, li") || mark.parentElement, t = tile.getBoundingClientRect();
      found.push({ ...row, beside: name(tile), lines: 0, off: Math.round((mid - (t.top + t.bottom) / 2) * 10) / 10 });
      continue;
    }
    // Up from the mark to the first box that has words beside it: an element next to it, or the box's own words.
    let words = null, where = null;
    // (A box that is display: contents has no place of its own: its children stand in its parent's layout.)
    const bare = (n) => getComputedStyle(n).display === "contents";
    const flat = (n) => [...n.children].flatMap((c) => (bare(c) ? flat(c) : [c]));
    for (let at = mark; at && at !== box.parentElement && !words; at = at.parentElement) {
      let parent = at.parentElement; if (!parent) break;
      while (bare(parent) && parent.parentElement) parent = parent.parentElement;
      // Its own words on the mark's line (a title with the mark inside it) come before anything else.
      const inline = lines(parent, true).filter((r) => r.top < m.bottom - 2 && r.bottom > m.top + 2);
      if (inline.length) { words = inline; where = parent; break; }
      const a = at.getBoundingClientRect();
      const beside = flat(parent).filter((c) => c !== at && !c.contains(mark) && seen(c) && !c.matches(MARKS)).map((c) => { const r = c.getBoundingClientRect(); return { c, r, gap: r.left >= m.right - 1 ? r.left - m.right : r.right <= m.left + 1 ? m.left - r.right : -1 }; })
        .filter((s) => s.gap >= 0 && s.r.top < m.bottom && s.r.bottom > m.top).map((s) => ({ ...s, rects: lines(s.c) })).filter((s) => s.rects.length).sort((p, q) => p.gap - q.gap);
      // Words beside it on its right come first; a time or a button far to the side is not its block.
      const right = beside.filter((s) => s.r.left >= m.right - 1);
      if ((right[0] || beside[0])) { const pick = right[0] || beside[0]; words = pick.rects; where = pick.c;
        // A mark that spans every row of a grid stands beside the whole column next to it, not its nearest row.
        if (/-1|span/.test(getComputedStyle(at).gridRowEnd)) words = flat(parent).filter((c) => c !== at && seen(c) && Math.abs(c.getBoundingClientRect().left - pick.r.left) <= 2).map((c) => c.getBoundingClientRect());
        break; }
    }
    const block = span(words || []);
    found.push({ ...row, beside: where ? name(where) : "", lines: words ? new Set(words.map((r) => Math.round(r.top))).size : 0, off: block ? Math.round((mid - (block.top + block.bottom) / 2) * 10) / 10 : null,
      block: block && [Math.round(block.top * 10) / 10, Math.round(block.bottom * 10) / 10] });
  }
  return found;
};

const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)))).then(() => page.waitForTimeout(120));
const modern = (theme) => (theme === "light" ? "light-modern" : "dark-modern");
const at = (n) => new Date(Date.UTC(2026, 10, 10, 9, n)).toISOString();
const WG = (n) => `wg_${String(n).padStart(16, "0")}`;
const DOCK = { type: "dock", pins: [], colours: {}, since: 1, show: "always", most: 8, size: 34 };

/** Opens every surface at `width` in `theme` ("dark" | "light") and calls visit(name, page, scope, mode) while each is
 *  in sight. mode: "words" (beside its words) or "tile" (alone in its tile). */
export async function eachSurface(browser, { width, theme }, visit) {
  const errors = [];
  // ---- the side bar: Work's list, the dock, the colour menu, Chat's list, Home's cards --------------------------------
  let x = await openDock(browser, { tab: "work", width, height: 760, theme: modern(theme), answering: [CHATS[1].id] });
  try {
    await x.settle();
    await visit("Work's list", x.page, "#sessions-list", "words");
    await visit("the dock's tiles (sessions)", x.page, "#dgc-dock", "tile");
    await x.page.hover("#sessions-list .session-row"); await x.page.click("#sessions-list .session-row .session-more"); await x.settle();
    await x.page.waitForFunction(() => document.querySelector(".dgc-pop").getAnimations().every((a) => a.playState === "finished"));
    await visit("the colour menu", x.page, ".dgc-pop", "tile");
    await x.page.keyboard.press("Escape"); await x.settle();
    await x.page.click("#side-tab-chat"); await x.settle();
    await visit("Chat's list", x.page, "#chats-list", "words");
    await x.page.click("#side-tab-home"); await x.settle();
    await visit("Home's session cards", x.page, "#home-hub", "words");
    errors.push(...x.errors);
  } finally { await x.close(); }
  x = await openDock(browser, { tab: "work", width, height: 760, theme: modern(theme), pins: LIBRARY_PINS });
  try { await x.settle(); await visit("the dock's tiles (Library pins)", x.page, "#dgc-dock", "tile"); errors.push(...x.errors); } finally { await x.close(); }

  // ---- a Work session's tab: its header, and an artifact's card in the chat ---------------------------------------------
  let w = await openWorkTab(browser, { width, height: 700, theme: modern(theme) });
  try {
    const event = (e) => w.send({ type: "event", event: e });
    await event({ type: "ready", version: "0.52.0", protocol_version: 14, capabilities: { artifacts: OFFER }, model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://localhost:11434/v1",
      workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
    await w.send({ type: "session_ready", sessionId: "s1" });
    await event({ type: "turn_start", turn_id: "t1", prompt: "Make a deck", kind: "prompt" });
    await event({ type: "artifact_changed", artifact: { id: ITEMS[0].id, type: "slides", label: "Slides", title: "Q3 plan", version: 1, op: "made", at: 0 }, op: "made", surface: "work" });
    await event({ type: "turn_end", turn_id: "t1" });
    await w.send({ type: "dock", ...DOCK }); await w.send({ type: "chat_tab", session: "s1" });
    await settle(w.page);
    await visit("a Work tab's header", w.page, ":has(> #session-blob)", "words");
    await visit("an artifact's card in a Work chat", w.page, ".dgc-doc-card", "words");
    errors.push(...w.errors);
  } finally { await w.page.close(); }

  // ---- ChatDGC: its header, a widget's card in its reply, an artifact's card, the chat's Widgets list --------------------
  let c = await openChatDgc(browser, { width, height: 760, theme: modern(theme) });
  try {
    await c.send(DOCK); await c.send({ type: "widgetsOffered", on: true });
    await c.send({ type: "artifacts", offered: OFFER });
    await c.send({ type: "opened", conversation: conversation(), earlier: 0, busy: false, messages: [
      { id: M(11), role: "user", text: "Make a widget and a deck", created_at: at(1) },
      { id: M(12), role: "assistant", text: "Here they are.", finish: "stop", created_at: at(2), widgets: [{ id: WG(1), title: "Tip calculator", html: "<title>Tip calculator</title><p>x</p>", created_at: at(2) }],
        artifacts: [{ id: ITEMS[0].id, type: "slides", label: "Slides", title: "Q3 plan", version: 1, op: "made", at: 0 }] },
      { id: M(13), role: "user", text: "Another widget", created_at: at(3) },
      { id: M(14), role: "assistant", text: "Done.", finish: "stop", created_at: at(4), widgets: [{ id: WG(2), title: "A widget with quite a long name that may take two lines in a narrow chat", html: "<title>Dice</title><p>x</p>", created_at: at(4) }] }] });
    await settle(c.page);
    await visit("a ChatDGC tab's header", c.page, "header, #cd-head, .cd-head", "words");
    await visit("a widget's card in its reply", c.page, ".cd-widget-card", "words");
    await visit("an artifact's card in ChatDGC", c.page, ".dgc-doc-card", "words");
    await c.page.click("#cd-widgets"); await settle(c.page);
    await c.page.waitForFunction(() => document.getElementById("cd-widgets-panel").getAnimations().every((a) => a.playState === "finished"));
    await visit("a chat's Widgets list", c.page, "#cd-widgets-panel", "words");
    errors.push(...c.errors);
  } finally { await c.page.close(); }

  // ---- the Library: its Artifacts rows (sheets) and its Widgets rows (Folios) -------------------------------------------
  let l = await openLibrary(browser, { width, height: 700, theme: modern(theme) });
  try {
    await l.send({ type: "library", files: [], total: 0, next: null, counts: {} });
    await l.send({ type: "widgetsOffered", on: true }); await l.send({ type: "artifactsOffered", on: true });
    await l.send({ type: "view", view: "artifacts" });
    await l.send({ type: "artifacts", items: [...ITEMS] });
    await settle(l.page);
    await visit("the Library's Artifacts rows", l.page, "#lib-list", "words");
    await l.send({ type: "view", view: "widgets" });
    await l.send({ type: "widgets", widgets: [1, 2, 3].map((n) => ({ id: WG(n), title: `Widget ${n}`, chat: { id: `chat_${"a".repeat(32)}`, title: "Q3 planning" }, created_at: at(n), bytes: 900 })), total: 3, next: null });
    await settle(l.page);
    await visit("the Library's Widgets rows", l.page, "#lib-list", "words");
    errors.push(...l.errors);
  } finally { await l.page.close(); }

  // ---- a Pip: its computer menu, its page's computer rows, a report's card in its chat ----------------------------------
  let p = await openPipChat(browser, { width, height: 800, where: width >= 600 ? "tab" : "side", theme, api: 86, convs: { computers: 3, states: ["open", { state: "working", doing: "Find a flat in Pune" }, "closed"] } });
  try {
    await p.p.waitForSelector("#pip-computer-open[aria-haspopup=menu]");
    await p.p.click("#pip-computer-open"); await p.p.waitForSelector("#computer-menu .computer-row");
    await p.p.waitForFunction(() => (window.__pipsRoot || document).querySelector("#computer-menu").getAnimations().every((a) => a.playState === "finished"));
    await visit("a Pip's computer menu", p.p, "#computer-menu", "words");
    errors.push(...p.errors);
  } finally { await p.close(); }
  p = await openPipChat(browser, { settings: true, width, where: width >= 600 ? "tab" : "side", theme, api: 86, convs: { computers: 2, states: [] } });
  try {
    await p.p.waitForSelector("#pip-convs");
    await p.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click());
    await p.p.waitForSelector("[data-computers] .computer-names li");
    await visit("the Pip page's computer rows", p.p, ".computer-names", "words");
    errors.push(...p.errors);
  } finally { await p.close(); }
  p = await openPipChat(browser, { project: true, width, theme, where: width >= 600 ? "tab" : "side" });
  try {
    await p.p.waitForSelector(".run-post .dgc-doc-card");
    await visit("a report's card in a Pip's chat", p.p, ".run-post .dgc-doc-card", "words");
    errors.push(...p.errors);
  } finally { await p.close(); }

  // ---- a Pip computer's tab: its slim bar, and "Showing <name> in another tab" ------------------------------------------
  const pc = await openComputer(browser, { width, height: 500, theme });
  try {
    await pc.p.evaluate(([pip]) => window.postMessage({ type: "pipComputerInit", pip: { ...pip, name: "Desk" }, desktop: true, number: 2, name: "Studio", numbers: false }, "*"), [PIP]);
    await pc.p.waitForFunction(() => document.querySelector(".pc-title h1").textContent === "Desk · Studio");
    await settle(pc.p);
    await visit("the computer tab's slim bar", pc.p, ".pc-title", "words");
    await pc.p.evaluate(() => window.postMessage({ type: "pipDesktopElsewhere", name: "Wren", number: 3 }, "*"));
    await pc.p.waitForSelector(".pc-overlay-card .portal");
    await settle(pc.p);
    await visit("“Showing <name> in another tab”", pc.p, ".pc-overlay-card", "words");
    errors.push(...pc.errors);
  } finally { await pc.close(); }
  return errors;
}

/** Every surface's name, in the order eachSurface visits them. */
export const SURFACES = ["Work's list", "the dock's tiles (sessions)", "the colour menu", "Chat's list", "Home's session cards", "the dock's tiles (Library pins)", "a Work tab's header",
  "an artifact's card in a Work chat", "a ChatDGC tab's header", "a widget's card in its reply", "an artifact's card in ChatDGC", "a chat's Widgets list", "the Library's Artifacts rows", "the Library's Widgets rows",
  "a Pip's computer menu", "the Pip page's computer rows", "a report's card in a Pip's chat", "the computer tab's slim bar", "“Showing <name> in another tab”"];
