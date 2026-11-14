// One shape for every control (asked 13 Nov: "all buttons and fields and dropdowns should match our style, we need to
// maintain one single design language throughout on all surfaces"; Home's Show dropdown was a pill). In real Chromium,
// on each surface as it is served, every interactive control that is drawn (a button, an icon button, a text or search
// field, a select or dropdown, a segmented control's parts, a menu's rows) is walked and its corner read: none is a
// pill (a corner of half its height or more, on a control wider than it is tall, or more than the button family allows
// on a square one). What stays round on purpose is listed in ROUND, with why; a control that matches none of it fails.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock } from "./support/dock-scene.mjs";
import { openGrid, EVERY } from "./support/home-grid-scene.mjs";
import { openWorkTab } from "./support/work-tab-scene.mjs";
import { openChat as openChatTab, conversation } from "./support/chat-scene.mjs";
import { openChat as openPip } from "./support/pip-chat-scene.mjs";
import { openRunningTurn, openPips, openSettingsGeneral } from "./support/codex-look-scene.mjs";
import { openSheet } from "./support/pip-cards-polish-scene.mjs";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";
import { openSettingsChanges } from "./support/settings-undo-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipOrFail = (t) => {
  const reason = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!reason) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

/** Round on purpose, because it is not a control's box (or is a mark that is one): [selector, why]. */
export const ROUND = [
  [".dgc-dock-item, .dgc-dock-item *", "the dock's tiles: squircles with a mark in each, the dock's own shape"],
  [".dgc-blob-button, [data-mark], .session-blob, .dgc-swatch, .dgc-swatch *", "a session's or a chat's coloured mark (a Voxel, a Mote) and the twelve colours it is chosen from: marks, not a button's box"],
  ["[role='switch'], .switch, button.switch, input[type='checkbox'], input[type='radio'], input[type='range']", "a toggle switch (its track and its knob), a tick box, a radio dot and a slider: their own shapes"],
  [".csend, #send, #stop, .cd-send, .chat-send, .vb-btn, .vb-send", "Send, Stop and the microphone inside a prompt box: the round button of a prompt box (kept; his call whether these go square too)"],
  [".info, .pip-tip-btn", "the small round “i” beside a title: an info mark"],
  [".msg-choice-key", "a key cap's number on a choice: a badge"],
];
/** Every control drawn under the page (and inside the Pips view's shadow root), with its corner; the ones that are a pill. */
const walk = (page, round) => page.evaluate((exceptions) => {
  const roots = [document]; for (const host of document.querySelectorAll("*")) if (host.shadowRoot) roots.push(host.shadowRoot);
  if (window.__pipsRoot && !roots.includes(window.__pipsRoot)) roots.push(window.__pipsRoot);
  const CONTROL = "button, input:not([type='hidden']), select, textarea, [role='button'], [role='tab'], [role='menuitem'], [role='menuitemradio'], [role='menuitemcheckbox'], [role='option'], [role='combobox'], [role='switch'], summary, a.btn, [contenteditable='true']";
  const probe = document.createElement("i"); probe.style.cssText = "position:absolute;visibility:hidden;border-radius:var(--btn-r)"; document.body.append(probe);
  const family = parseFloat(getComputedStyle(probe).borderTopLeftRadius) || 6; probe.remove();
  const out = { walked: 0, pills: [], kept: {}, family };
  for (const root of roots) for (const node of root.querySelectorAll(CONTROL)) {
    if (!node.checkVisibility({ visibilityProperty: true })) continue;
    const r = node.getBoundingClientRect(), s = getComputedStyle(node);
    if (r.width < 8 || r.height < 8) continue;
    out.walked++;
    const corner = Math.max(...[s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map((v) => (v.includes("%") ? (parseFloat(v) / 100) * Math.min(r.width, r.height) : parseFloat(v)) || 0));
    // A box that is drawn: a fill, a line or a shadow. (A bare word or icon with no box has no shape to read; its hover wash is read when it shows.)
    const alpha = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || []; return c === "transparent" ? 0 : (m.length > 3 ? m[3] : 1); };
    const boxed = alpha(s.backgroundColor) > 0.02 || s.backgroundImage !== "none" || (parseFloat(s.borderTopWidth) > 0 && alpha(s.borderTopColor) > 0.02) || s.boxShadow !== "none";
    const half = Math.min(r.width, r.height) / 2;
    // A pill: on a control wider than tall, a corner of (about) half its height; on a square one, a circle. Either way more than the family's own corner allows.
    const pill = corner > family + 2.5 && corner >= half - 1.5;
    if (!pill) continue;
    const why = exceptions.find(([sel]) => { try { return node.matches(sel); } catch { return false; } });
    const name = `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}${typeof node.className === "string" && node.className ? "." + node.className.trim().split(/\s+/).slice(0, 3).join(".") : ""}`;
    if (why) { out.kept[why[1]] = (out.kept[why[1]] || 0) + 1; continue; }
    out.pills.push(`${name} “${(node.getAttribute("aria-label") || node.textContent || node.placeholder || "").trim().replace(/\s+/g, " ").slice(0, 30)}” ${Math.round(r.width)}×${Math.round(r.height)} corner ${Math.round(corner * 10) / 10}${boxed ? "" : " (no box at rest)"}`);
  }
  return out;
}, round);
/** Walks are gathered over a whole surface and held at its end, so one run names every pill there is. */
let pills = [];
const held = (found, where) => {
  assert.ok(found.walked >= 3, `${where}: its controls were walked (${found.walked})`);
  for (const pill of found.pills) if (!pills.includes(`${where}: ${pill}`)) pills.push(`${where}: ${pill}`);
};
const none = () => { const all = pills; pills = []; assert.deepEqual(all, [], "no control is a pill (the button family's corner is --btn-r, 6 px)"); };
/** Fix 13: every control's highlight is its own. Each control drawn on the page is pointed at in turn, and what lights
 *  up is read: the element whose fill changed must be the control itself (never the row or the line it stands in), with
 *  a corner in the button family (never a pill), and a highlight the height of a button or less wide than its row. */
const hoverWalk = async (page, scope, round) => {
  const targets = await page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((n) => n.checkVisibility({ visibilityProperty: true }) && !n.disabled && n.getBoundingClientRect().width > 8)
    .map((n, i) => { n.dataset.hoverWalk = String(i); const r = n.getBoundingClientRect(); return { i, x: r.left + Math.min(r.width / 2, 12), y: r.top + r.height / 2 }; }), scope);
  const out = [];
  for (const target of targets) {
    await page.mouse.move(2, 2); await page.waitForTimeout(40);
    const rest = await page.evaluate((i) => { const n = document.querySelector(`[data-hover-walk="${i}"]`); if (!n) return null; const all = [n, ...(function up(e, a) { return e.parentElement && a.length < 4 ? up(e.parentElement, [...a, e.parentElement]) : a; })(n, [])]; return all.map((e) => getComputedStyle(e).backgroundColor); }, target.i);
    if (!rest) continue;
    await page.mouse.move(target.x, target.y, { steps: 2 }); await page.waitForTimeout(260);
    const now = await page.evaluate(([i, exceptions]) => { const n = document.querySelector(`[data-hover-walk="${i}"]`); if (!n) return null;
      const all = [n, ...(function up(e, a) { return e.parentElement && a.length < 4 ? up(e.parentElement, [...a, e.parentElement]) : a; })(n, [])];
      const s = getComputedStyle(n), r = n.getBoundingClientRect(), row = n.parentElement.getBoundingClientRect();
      return { fills: all.map((e) => getComputedStyle(e).backgroundColor), own: all.map((e, k) => k === 0 || e.matches("[tabindex], button, a, [role='button'], [role='option'], [role='menuitem'], li.session-row, .dgc-hub-card") || e.getBoundingClientRect().width < innerWidth * 0.6), name: `${n.tagName.toLowerCase()}${n.id ? "#" + n.id : ""}.${String(n.className).trim().split(/\s+/)[0]}`, radius: parseFloat(s.borderTopLeftRadius) || 0, w: r.width, h: r.height, rowW: row.width,
        kept: exceptions.some(([sel]) => { try { return n.matches(sel); } catch { return false; } }), outline: s.outlineStyle }; }, [target.i, round]);
    if (!now || now.kept) continue;
    // (A control inside a row that is itself a control, a session's pin in its row, lights its row too: that is the row's own highlight.
    // What is held is that no bare line of the page lights up: something that is no control and spans most of the page's width.)
    const lit = now.fills.findIndex((fill, k) => fill !== rest[k] && !(k > 0 && now.own[k]));
    out.push({ ...now, lit });
  }
  await page.mouse.move(2, 2);
  await page.evaluate(() => { for (const n of document.querySelectorAll("[data-hover-walk]")) delete n.dataset.hoverWalk; });
  return out;
};
const hoverHeld = (found, where) => {
  for (const c of found) {
    if (c.lit > 0) pills.push(`${where}: pointing at ${c.name} lights what it stands in, not the control itself`);
    if (c.lit === 0 && c.radius > 8.5 && c.radius >= Math.min(c.w, c.h) / 2 - 1.5) pills.push(`${where}: ${c.name}'s highlight is a pill (corner ${c.radius})`);
  }
};
const settle = (page, ms = 150) => page.evaluate((w) => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, w)))), ms);

for (const theme of ["dark-modern", "light-modern"]) for (const width of [640, 300]) {
  test(`the side bar: Home, Work, Chat and the Pips view, their menus and New Session's dialog (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    // Home is cards (13 Nov): every card that there is, with what a host would say, then the card library and Arrange Home.
    const x = await openGrid(browser, { theme, width, height: 1400, layout: EVERY, settings: { weather: { city: "Lisbon", unit: "c" }, clock: { zone: "Asia/Tokyo" } } });
    try {
      const p = x.page;
      held(await walk(p, ROUND), "Home");
      hoverHeld(await hoverWalk(p, "#home-hub button", ROUND), "Home");
      await p.click(".hc-cards-btn"); await settle(p, 300);
      held(await walk(p, ROUND), "Home, the card library open");
      await p.click(".hc-library .hc-arrange"); await settle(p, 400);
      held(await walk(p, ROUND), "Arrange Home");
      await p.click(".hc-done"); await settle(p, 400);
      // Needs you opened whole: the cards with their answers, as Home listed them.
      await p.evaluate(() => document.querySelector("#home-hub .dgc-hub-rest")?.click()); await settle(p, 300);
      if (width === 300) { await p.click('.hc-grid .hc-card[data-card="needs"]', { position: { x: 40, y: 8 } }); await settle(p, 300); }
      held(await walk(p, ROUND), "Home, Needs you opened");
      hoverHeld(await hoverWalk(p, "#home-hub button", ROUND), "Home, Needs you opened");
      await p.click("#side-tab-work"); await settle(p);
      held(await walk(p, ROUND), "Work");
      hoverHeld(await hoverWalk(p, "#work-home button, #work-home input", ROUND), "Work");
      // Library is one control on Work and on Chat (13 Nov): the same box, hugging its icon and word, lit the same way.
      // (Its highlight is read where it ends, with fades held off for the reading: on a busy machine a fade outlasts
      // any fixed wait.)
      const library = async (id) => { await p.mouse.move(2, 2);
        await p.evaluate(() => { const s = document.createElement("style"); s.id = "no-fades"; s.textContent = "*, *::before, *::after { transition: none !important; }"; document.head.append(s); });
        await settle(p, 60); await p.hover(`#${id}`); await settle(p, 60);
        return p.evaluate((i) => { const n = document.getElementById(i), s = getComputedStyle(n), r = n.getBoundingClientRect(), words = document.createRange(); words.selectNodeContents(n); const w = words.getBoundingClientRect(), row = document.getElementById("sessions-host").getBoundingClientRect();
          return { size: [Math.round(r.width * 10) / 10, Math.round(r.height * 10) / 10], radius: s.borderTopLeftRadius, fill: s.backgroundColor, font: s.font, pad: [s.paddingLeft, s.paddingRight], hugs: r.width - w.width <= 24, line: r.width > row.width * 0.6, left: Math.round((r.left - row.left) * 10) / 10 }; }, id).finally(() => p.evaluate(() => document.getElementById("no-fades")?.remove())); };
      const workLibrary = await library("work-library");
      await p.hover("#sessions-list .session-row"); await settle(p);
      held(await walk(p, ROUND), "Work, a row pointed at (its buttons)");
      await p.click("#side-tab-chat"); await settle(p);
      held(await walk(p, ROUND), "Chat");
      hoverHeld(await hoverWalk(p, "#chats-home button, #chats-home input", ROUND), "Chat");
      const chatLibrary = await library("chats-library");
      assert.deepEqual(chatLibrary, workLibrary, "Library is the same control on Work and on Chat: its size, its corner, its highlight, its place");
      assert.deepEqual([workLibrary.radius, workLibrary.size[1], workLibrary.hugs, workLibrary.line, /^rgba?\(0, 0, 0, 0\)$/.test(workLibrary.fill)], ["6px", 28, true, false, false], `Library pointed at: a lit box in the button's shape and height, hugging its icon and word, never the whole line (${JSON.stringify(workLibrary)})`);
      await p.click("#side-tab-pips"); await settle(p, 500);
      held(await walk(p, ROUND), "the Pips view");
      none();
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  });
}
for (const theme of ["dark-modern", "light-modern"]) {
  test(`a Work session's tab: its header, its prompt box, a running turn with its cards (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const w = await openWorkTab(browser, { width: 700, theme });
    try { held(await walk(w.page, ROUND), "a new Work session"); assert.deepEqual(w.errors, []); } finally { await w.page.close(); }
    const r = await openRunningTurn(browser, { width: 700, theme, approval: true });
    try { held(await walk(r.page, ROUND), "a running turn with a permission card and a queue"); } finally { await (r.close ? r.close() : r.page.close()); }
    none();
  });
  test(`a ChatDGC chat's tab: its header and its prompt box (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const c = await openChatTab(browser, { width: 700, theme });
    try {
      await c.send({ type: "opened", conversation: conversation({ title: "A week in Goa" }), earlier: 0, busy: false, messages: [] }); await settle(c.page);
      held(await walk(c.page, ROUND), "a ChatDGC chat");
    } finally { await c.page.close(); }
    none();
  });
}
// A Work chat with Pip report cards (asked 13 Nov: "the Pips cards that come in work sessions needs UI polish"): closed,
// opened with every finding shown, two folded into one line and opened, one asked about, and a fix's row.
for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`a Work chat with Pip report cards: closed, opened, grouped, asked and fixed (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const CONTROLS = "#log .pip-report button, #log .pip-report-group-head, #log .pip-report [role='button'], #log .pip-report [role='link']";
    for (const sheet of ["cards", "opened", "two-opened-card", "asked", "fixed"]) {
      const page = await openSheet(browser, sheet, { width, theme });
      try {
        if (sheet === "opened") { await page.click("#log .pip-report .pip-report-all"); await settle(page); }
        const found = await walk(page, ROUND);
        assert.ok(await page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((n) => n.checkVisibility()).length >= 3, CONTROLS), `${sheet}: the cards' controls are drawn`);
        held(found, `report cards, ${sheet}`);
        hoverHeld(await hoverWalk(page, CONTROLS, ROUND), `report cards, ${sheet}`);
      } finally { await page.close(); }
    }
    none();
  });
}
// A Work chat in which DGC changed its own settings (0.52): each change's quiet line and its Undo.
for (const theme of ["dark-modern", "light-modern"]) for (const width of [700, 300]) {
  test(`a Work chat with settings change lines and their Undo (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const CONTROLS = "#log .setting-change button";
    const x = await openSettingsChanges(browser, { width, theme, fresh: true });
    try {
      assert.equal(await x.page.evaluate((sel) => [...document.querySelectorAll(sel)].filter((n) => n.checkVisibility()).length, CONTROLS), 3, "each line's Undo is drawn");
      held(await walk(x.page, ROUND), "settings change lines");
      hoverHeld(await hoverWalk(x.page, CONTROLS, ROUND), "settings change lines");
    } finally { await x.close(); }
    none();
  });
}
for (const theme of ["dark", "light"]) {
  test(`the Pips page, a Pip's chat, and Settings (${theme})`, async (t) => {
    if (skipOrFail(t)) return;
    const list = await openPips(browser, { width: 700, theme, list: true });
    try { held(await walk(list.page || list.p, ROUND), "the Pips page"); } finally { await (list.close ? list.close() : (list.page || list.p).close()); }
    const chat = await openPip(browser, { width: 700, theme, where: "tab" });
    try { held(await walk(chat.p || chat.page, ROUND), "a Pip's chat"); } finally { await (chat.close ? chat.close() : (chat.p || chat.page).close()); }
    for (const section of ["general", "models"]) {
      const s = await openSettingsGeneral(browser, { width: 900, theme, section });
      try { held(await walk(s.page || s.p, ROUND), `Settings, ${section}`); } finally { await (s.close ? s.close() : (s.page || s.p).close()); }
    }
    none();
  });
}
// One Pips (0.52, Pips API 94 to 96): the one list with its search and filter line, the filter's menu, New Pip, a Pip's
// chat at each step of the flow (the findings card, the Allow card and its menu, the fix at work, the change card,
// what waits on you), its settings page, its reports table and the Do it all warning.
for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 700]) {
  test(`One Pips: the list, New Pip, a Pip's chat with the flow's cards, its settings and its reports (${theme}, ${width}px)`, async (t) => {
    if (skipOrFail(t)) return;
    const inMenu = (x, tab) => x.inPips((root, v) => [...root.querySelectorAll(".pip-topbar .pip-menu [data-tab]")].find((b) => b.dataset.tab === v).click(), tab);
    let x = await openOnePips(browser, { width, theme, scene: { fix: "ask" } });
    try {
      held(await walk(x.page, ROUND), "One Pips: the list");
      await x.click("#pips-filter"); await x.waitIn(".dgc-folder-menu"); await settle(x.page, 450);
      held(await walk(x.page, ROUND), "One Pips: the filter's menu");
      await x.page.keyboard.press("Escape"); await settle(x.page, 300);
      await x.click("#simple-new"); await x.waitIn("#review-root .dialog"); await settle(x.page);
      held(await walk(x.page, ROUND), "One Pips: New Pip");
      await x.click("#review-cancel"); await settle(x.page);
      await x.openPip(GST); await x.waitIn(".pip-found-ask");
      await x.click("#pip-waiting-toggle"); await x.waitIn(".pip-found-waiting"); await x.click("[data-flow-menu]"); await x.waitIn(".pip-found-menu"); await settle(x.page);
      held(await walk(x.page, ROUND), "One Pips: a chat with the findings card, the Allow card and what waits on you");
      await x.click("#chat-level"); await x.waitIn(".composer-level-menu");
      await x.inPips((root) => [...root.querySelectorAll(".composer-level-menu [data-pip-level-pick]")][2].click()); await x.waitIn("#review-root .dialog"); await settle(x.page);
      held(await walk(x.page, ROUND), "One Pips: the Do it all warning");
      await x.click("#review-cancel"); await settle(x.page);
      await inMenu(x, "job"); await x.waitIn(".pip-folder-parts"); await settle(x.page);
      held(await walk(x.page, ROUND), "One Pips: a folder Pip's settings page");
      await x.click('.pip-folder-parts [data-tab="runs"]'); await x.waitIn("table.pip-reports"); await settle(x.page);
      held(await walk(x.page, ROUND), "One Pips: the reports table");
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
    for (const fix of ["running", "ready", "applied"]) {
      x = await openOnePips(browser, { width, theme, scene: { fix, level: fix === "applied" ? "full" : "ask" } });
      try { await x.openPip(GST); await x.waitIn(fix === "running" ? ".pip-found-fixing" : "[data-project-change]"); await settle(x.page);
        held(await walk(x.page, ROUND), `One Pips: a chat with the fix ${fix}`); assert.deepEqual(x.errors, []); } finally { await x.close(); }
    }
    none();
  });
}
