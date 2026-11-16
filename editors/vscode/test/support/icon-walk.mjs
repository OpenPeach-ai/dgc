// One action, one icon: the walk of every surface that reads each control with the action its name says and the glyph
// it draws (uir2c-icons.test.mjs holds the rule; the layout audit reads the same walk for its report). Not a *.test.mjs file.
import { glyphsWithMenus, glyphs } from "./uir2c-scene.mjs";
import { openWork, openChatDgc, openPip } from "./uir2a-scene.mjs";
import { openHomeCards, grid } from "./uir2b-scene.mjs";
import { openHome } from "./home-scene.mjs";
import { openDock } from "./dock-scene.mjs";
import { openLibraryTab, openLibraryPage } from "./library-scene.mjs";
import { openOnePips, MORNINGS } from "./one-pips-scene.mjs";

/** The one glyph each action draws. */
export const GLYPH = { "open-in-editor": "go-to-file", more: "more", back: "arrow-left", settings: "settings-gear", add: "add", close: "close", copy: "copy", delete: "trash", pin: "pin", unpin: "unpin", archive: "archive", stop: "debug-stop", save: "desktop-download" };
// (The box's own Stop is the Send button's other state, drawn by each box: read, and held to one drawing, but not the row glyph.)

/** Every surface, read: [{ where, action, label, sig, size, shown, menu }]. */
export async function walkGlyphs(browser) {
  const found = [], take = async (page, where, opts) => { found.push(...await glyphsWithMenus(page, where, opts)); };
  // Work: the side bar's list of sessions (a row pointed at), and a session's own page.
  { const x = await openDock(browser, { tab: "work", width: 440 });
    try { await x.page.hover("#sessions-list .session-row").catch(() => {}); await x.page.waitForTimeout(120); await take(x.page, "Work's list"); } finally { await x.page.close(); } }
  { const x = await openWork(browser, { width: 700, turns: 1, running: true });
    try { await take(x.page, "a Work session"); } finally { await x.page.close(); } }
  // The side bar's Chat list, and ChatDGC's page.
  { const x = await openHome(browser, { tab: "chat", width: 440 });
    try { await x.page.hover("#chats-list .chat-row").catch(() => {}); await x.page.waitForTimeout(120); await take(x.page, "the Chat list"); } finally { await x.page.close(); } }
  { const x = await openChatDgc(browser, { width: 700, turns: 1 });
    try { await take(x.page, "ChatDGC"); } finally { await x.page.close(); } }
  // Pips: the list (a row pointed at), a Pip's chat in the side bar and in its tab, and its page.
  for (const where of ["side", "tab"]) { const x = await openOnePips(browser, { where, width: where === "side" ? 300 : 700, api: 103 });
    try { await take(x.page, `the Pips list (${where})`); await x.openPip(MORNINGS); await take(x.page, `a Pip's chat from the list (${where})`);
      // Its page: Settings, from the chat's menu.
      await x.inPips((root) => root.querySelector('.pip-menu [data-tab="settings"], .pip-menu [data-tab]')?.click()); await x.page.waitForTimeout(300); await take(x.page, `a Pip's page (${where})`); } finally { await x.close(); } }
  for (const width of [300, 700]) { const x = await openPip(browser, { width, said: [{ role: "user", text: "Which sources?" }, { role: "assistant", text: "Two: the tide tables and the port log." }] });
    try { await take(x.page, `a Pip's chat (${width}px)`); } finally { await x.close(); } }
  // Home (every card), the Library in the side bar and in its tab, and the dock with its menus.
  { const x = await openHomeCards(browser, { width: 440, layout: grid.EVERY });
    try { await take(x.page, "Home"); await x.page.click("#dgc-dock .dgc-dock-add, #dgc-dock [data-add]").catch(() => {}); await x.page.waitForTimeout(150); found.push(...await glyphs(x.page, "the dock's New menu"));
      await x.page.keyboard.press("Escape"); await x.page.click("#dgc-dock .dgc-dock-tile", { button: "right" }).catch(() => {}); await x.page.waitForTimeout(150); found.push(...await glyphs(x.page, "a dock tile's menu")); } finally { await x.page.close(); } }
  { const x = await openLibraryTab(browser, { width: 440 });
    try { await x.page.hover(".lib-row, #lib-list li").catch(() => {}); await take(x.page, "the Library (side bar)"); } finally { await x.page.close(); } }
  { const x = await openLibraryPage(browser, { width: 1100 });
    try { await x.page.hover(".lib-row, #lib-list li").catch(() => {}); await take(x.page, "the Library (tab)"); } finally { await x.close(); } }
  return found;
}

/** The surfaces the walk must have read (a premise: each draws controls with these actions). */
export const GLYPH_PLACES = ["Work's list", "a Work session", "the Chat list", "ChatDGC", "the Pips list (side)", "the Pips list (tab)", "a Pip's chat (300px)", "a Pip's chat (700px)", "a Pip's page (side)", "a Pip's page (tab)", "Home", "the Library (side bar)", "the Library (tab)"];
/** One action, one glyph: what the walk found drawn as another glyph than its action's. */
export function glyphFaults(found) {
  const byAction = new Map();
  for (const f of found) { if (!byAction.has(f.action)) byAction.set(f.action, new Map()); const m = byAction.get(f.action); if (!m.has(f.sig)) m.set(f.sig, []); m.get(f.sig).push(`${f.where}: “${f.label}”`); }
  const off = [];
  for (const [action, sigs] of byAction) {
    if (action === "stop-reply") continue;
    for (const [sig, at] of sigs) if (sig !== GLYPH[action]) off.push(`${action} is drawn as ${sig} (not ${GLYPH[action]}) at ${[...new Set(at)].slice(0, 4).join("; ")}`);
  }
  return { off, byAction };
}
/** A glyph is 16 px in a header or row button and 15 px in a menu row. Not held to the two sizes, each for its own
    reason: More is the menus' three dots, 14 on its box wherever it is (DgcMenu.DOTS); a glyph beside a word ("+ New")
    is the word's size; the row of small buttons under a message is 12 on every surface; Home's cards draw their corner
    buttons at a card's own small scale. */
export function sizeFaults(found) {
  const held = found.filter((f) => f.shown && GLYPH[f.action] === f.sig && f.action !== "more" && (f.menu || !f.worded) && !f.message && !/^(Home|the dock|a dock)/.test(f.where));
  return [...new Set(held.filter((f) => (f.menu ? Math.abs(f.size - 15) > 0.6 : Math.abs(f.size - 16) > 0.6)).map((f) => `${f.where}: “${f.label}” draws ${f.sig} at ${f.size}px (${f.menu ? "a menu row: 15" : "a button: 16"})`))];
}
