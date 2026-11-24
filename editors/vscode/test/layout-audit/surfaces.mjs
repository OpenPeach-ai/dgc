// Which pages the layout audit walks, in which states, at which sizes. The pages are the scenes the tests already use
// (test/support/polish-scenes.mjs: every screen of DGC with its states), plus the few it had no scene for: the Library in
// its editor tab, a Pip's computer tab, the file cards of a chat, and the lists filled with 200 things with awkward
// names. A scene is (browser, { width, theme, touch }, visit): it calls visit(state, page, options) while each state
// is on screen. Not a *.test.mjs file.
import { SCENES as POLISH } from "../support/polish-scenes.mjs";
import { openDock } from "../support/dock-scene.mjs";
import { openLibraryTab, openLibraryPage, LIB_ARTIFACTS } from "../support/library-scene.mjs";
import { openComputer } from "../support/pip-computer-scene.mjs";
import { openWorkFiles, openChatFiles } from "../support/uir2c-scene.mjs";
import { openWork, openChatDgc, openPip } from "../support/uir2a-scene.mjs";
import { openHomeCards, grid } from "../support/uir2b-scene.mjs";
import { modelsMessage } from "../support/model-menu-scene.mjs";

const modern = (theme) => `${theme}-modern`;
const settle = (page, ms = 160) => page.evaluate((n) => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, n)))), ms);
const scrollAll = (page, to = "end") => page.evaluate((where) => { const walk = (root) => { for (const n of root.querySelectorAll("*")) { const s = getComputedStyle(n); if (/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 24) n.scrollTop = where === "end" ? n.scrollHeight : 0; if (n.shadowRoot) walk(n.shadowRoot); } }; walk(document); }, to);

// Names as people write them: very long with no spaces, short, not Latin, right to left, emoji, accents.
export const NAMES = ["Supercalifragilisticexpialidocious_no_spaces_at_all_in_this_very_long_session_name_0123456789_and_on_and_on",
  "A", "Fix the login", "これは非常に長い日本語のセッション名で、狭いサイドバーには収まりません", "短い名前", "مرحبا بالعالم هذا اسم طويل جدا للجلسة الحالية", "🚀🔥 Launch day 🎉🎉🎉 with a long tail of words after the emoji",
  "Résumé: naïve façade, coöperate and Ærøskøbing", "A name of ordinary length that still needs more room than a narrow side bar has", "1,000,000 rows × 3 columns"];
const grows = (k) => [1, 9, 10, 99, 100, 999, 1000, 12345][k % 8];       // (numbers that grow: 1 → 1,000 and past it)
const SESSIONS_200 = Array.from({ length: 200 }, (_, k) => ({ id: `202611${String(10 + (k % 5)).padStart(2, "0")}-10${String(10 + (k % 50)).padStart(2, "0")}${String(k % 60).padStart(2, "0")}-s${k}`, path: `/s/s${k}.json`,
  name: NAMES[k % NAMES.length], preview: k % 4 === 0 ? `${NAMES[(k + 3) % NAMES.length]} ${NAMES[0]}` : "", when: `2026-11-${String(13 - (k % 9)).padStart(2, "0")} 10:15`, count: grows(k), open: k === 1, running: k === 2, waiting: k === 4 }));
const CHATS_200 = Array.from({ length: 200 }, (_, k) => ({ id: `chat_s${k}`, title: NAMES[k % NAMES.length], preview: k % 3 ? `${NAMES[(k + 5) % NAMES.length]}` : "", updated_at: `2026-11-${String(13 - (k % 9)).padStart(2, "0")}T09:00:00Z`, pinned: k < 2 }));
const ARTIFACTS_200 = Array.from({ length: 200 }, (_, k) => ({ ...LIB_ARTIFACTS[k % LIB_ARTIFACTS.length], id: "ar_" + String(k).padStart(16, "b"), title: NAMES[k % NAMES.length],
  ...(k % 3 ? {} : { made_by: { kind: "pip", id: "pip_" + "9".repeat(32), name: NAMES[(k + 1) % NAMES.length] } }) }));
const LONG_PROMPTS = [`Where is ${NAMES[0]} read?`, NAMES[3], NAMES[5], NAMES[6]];

/** A Work session's stand-in host answers the page's "which models?" as the editor does, so its model menu opens with
 *  its rows (not "Loading…") when the walk presses the model button. */
const workHost = (page) => page.evaluate((models) => { if (window.__laHost || !Array.isArray(window.__posted)) return; window.__laHost = true; const posted = window.__posted, push = posted.push;
  posted.push = function (m) { const n = push.call(this, m); if (m && m.type === "listModels") setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: models })), 15); return n; }; }, modelsMessage());

/** Home folds by the width: a card is Small, Medium or Large (the bento), and a Small card shows the one thing and opens
 *  whole on a press. An action a Large card shows is reached, at a width where the card is Small, by opening the card:
 *  this opens it, looks for the action there, and goes back. */
const homeCardReach = async (page, a, same) => {
  const at = await page.evaluate((sels) => { const L = window.__la; let c = null; for (const sel of sels) { if (!sel) continue; const el = L.all(sel).find((n) => n.closest(".hc-grid")); c = el && (el.closest(".hc-card") || el); if (c) break; } if (!c) return null;
    c.scrollIntoView({ block: "center" }); const r = c.getBoundingClientRect(); return { x: r.left + 12, y: r.top + 8, card: c.dataset.card || "" }; }, [a.owner, a.outer]);
  if (!at) return "";
  await page.mouse.click(at.x, at.y); await settle(page, 600);
  if (!(await page.evaluate(() => !!document.querySelector("#home-hub .hc-open")))) return "";
  const acts = await page.evaluate(() => Object.values(window.__la.read({ scope: "#home-hub" }).actions).filter((x) => x.ok).map((x) => x.act));
  await page.evaluate(() => document.querySelector("#home-hub .hc-back")?.click()); await settle(page, 500);
  // (What a Large card offers to go to its own whole view, "Open Recent whole", "2 more", "All Pips", is the press that opened it.)
  const opener = /(\bwhole$|^open all of it$|\bmore$|^show the rest|^all \w+$)/i.test(a.act);
  return opener || acts.some(same) ? `in the card once it is opened (a press on the Small ${at.card || "card"} card)` : "";
};

const OWN = {
  // The Library in its editor tab (the page src/chatdgc.ts serves), each of its tabs.
  "library-page": async (b, { width, theme, touch }, visit) => {
    // (A DGC that keeps favorites: every row has its star, one of them filled, and the filters have Favorites.)
    const x = await openLibraryPage(b, { width, theme: modern(theme), touch, scale: 1, favorites: [`artifact:${LIB_ARTIFACTS[1].id}`] });
    try { await visit("list", x.page);
      for (const tab of ["widgets", "images", "videos", "files"]) { await x.libTab(tab); await visit(tab, x.page); }
      await x.libTab("artifacts"); await scrollAll(x.page, "end"); await x.settle(); await visit("list-end", x.page);
    } finally { await x.close(); }
  },
  // A Pip's computer tab: its bar, its menus, its size picker.
  "pip-computer": async (b, { width, theme, touch }, visit) => {
    const x = await openComputer(b, { width, height: 640, theme, touch });
    try { await x.p.waitForTimeout(200); await visit("screen", x.p); } finally { await x.close(); }
  },
  // The file cards of a chat (a Work session's and ChatDGC's): each card's "…" and its right-click.
  "chat-files": async (b, { width, theme }, visit) => {
    let x = await openWorkFiles(b, { width, theme: modern(theme) });
    try { await visit("work-files", x.page); } finally { await x.page.close(); }
    x = await openChatFiles(b, { width, theme: modern(theme) });
    try { await visit("chatdgc-files", x.page); } finally { await x.page.close(); }
  },
  // A Pip's chat from the scene the chat tests use (in the side bar under 400 px, its own tab above).
  "pip-chat": async (b, { width, theme }, visit) => {
    const x = await openPip(b, { width, theme: modern(theme), said: [{ role: "user", text: "Which sources?" }, { role: "assistant", text: "Two: the tide tables and the port log." }, { role: "user", text: NAMES[0] }, { role: "assistant", text: `${NAMES[3]} ${NAMES[6]}` }] });
    try { await visit("chat", x.page); } finally { await x.close(); }
  },
  // Home with every card, the dock under it.
  "home-every-card": async (b, { width, theme, touch }, visit) => {
    const x = await openHomeCards(b, { width, theme: modern(theme), layout: grid.EVERY, touch });
    try { await visit("cards", x.page); await scrollAll(x.page, "end"); await settle(x.page, 250); await visit("cards-end", x.page); } finally { await x.page.close(); }
  },
  // Real-world content: 200 things in each list, with names that are very long, have no spaces, are not Latin, run
  // right to left or are emoji, and numbers that grow; each list read at its top and scrolled to its end under the dock.
  "stress-lists": async (b, { width, theme, touch }, visit) => {
    let x = await openDock(b, { tab: "work", width, height: 760, theme: modern(theme), sessions: SESSIONS_200, touch });
    try { await x.settle(); await visit("work-200", x.page); await scrollAll(x.page, "end"); await x.settle(); await visit("work-200-end", x.page); } finally { await x.close(); }
    x = await openDock(b, { tab: "chat", width, height: 760, theme: modern(theme), touch });
    try { await x.send({ type: "chatdgc_list", available: true, items: CHATS_200, open: ["chat_s1"], answering: ["chat_s3"] }); await x.settle(); await visit("chat-200", x.page); await scrollAll(x.page, "end"); await x.settle(); await visit("chat-200-end", x.page); } finally { await x.close(); }
    x = await openLibraryTab(b, { width, theme: modern(theme), touch, artifacts: ARTIFACTS_200, pageSize: 200, favorites: [`artifact:${ARTIFACTS_200[0].id}`, `artifact:${ARTIFACTS_200[3].id}`] });
    try { await visit("library-200", x.page); await scrollAll(x.page, "end"); await x.settle(); await visit("library-200-end", x.page); } finally { await x.close(); }
    // The dock hidden: the same list with no dock under it.
    x = await openDock(b, { tab: "work", width, height: 760, theme: modern(theme), sessions: SESSIONS_200.slice(0, 40), show: "never", touch });
    try { await x.settle(); await scrollAll(x.page, "end"); await x.settle(); await visit("work-no-dock-end", x.page); } finally { await x.close(); }
  },
  // What's new (the dialog the side bar shows once a release), each of its seven slides: first with its scenes moving
  // (motion on: a state read under reduced motion once hid a fade that left words see-through), then again still.
  "whats-new": async (b, { width, theme, touch }, visit) => {
    for (const motion of ["no-preference", "reduce"]) {
      const x = await openDock(b, { tab: "home", width, height: 760, theme: modern(theme), touch, motion });
      try {
        await x.send({ type: "whatsNew", auto: true, release: "0.52" }); await x.page.waitForSelector("#whats-new:not([hidden])"); await settle(x.page, 400);
        for (let k = 0; k < 8; k++) {
          await visit(`${motion === "reduce" ? "still" : "moving"}-${k + 1}`, x.page, { scope: "#whats-new", hover: false, focus: k === 0 });
          if (k < 7) { await x.page.evaluate((i) => document.querySelectorAll("#whats-new .wn-dot")[i]?.click(), k + 1); await settle(x.page, 300); }
        }
      } finally { await x.close(); }
    }
  },
  "stress-chats": async (b, { width, theme }, visit) => {
    let x = await openWork(b, { width, theme: modern(theme), prompts: LONG_PROMPTS });
    try { await visit("work-long-words", x.page); } finally { await x.page.close(); }
    x = await openChatDgc(b, { width, theme: modern(theme), prompts: LONG_PROMPTS });
    try { await visit("chatdgc-long-words", x.page); } finally { await x.page.close(); }
  },
};
export const SCENES = { ...POLISH, ...OWN };

// ---- the sizes ---------------------------------------------------------------------------------------------------------
export const WIDTHS = [300, 360, 440, 700, 1000];
/** The sweep: every 20 px from 260 to 1200, and the side bar's real minimum (170). */
export const SWEEP = (() => { const w = [170]; for (let x = 260; x <= 1200; x += 20) w.push(x); return w; })();
/** The sampled sweep, for a page's second states (the same rows and bars as its first, with other content): the fixed
 *  widths, the ends, and the side bar's minimum. */
export const SWEEP_SAMPLED = [170, 260, 300, 360, 440, 560, 700, 840, 1000, 1200];
export const SWEEP_WORDS = [260, 360, 440, 560, 700, 1000, 1200];     // (170, 220 and 300: narrowest-words-browser.test.mjs)

// What is done in a state, by letter:
//   L  open every layer by the pointer and measure it     K  …and open each by the keyboard (Enter, Escape, the focus)
//   T  the hover labels                                   R  the page at rest (words, the button family, one row's controls)
//   S  the full width sweep                               s  the sampled sweep
//   O  measure the layer the scene opened itself (a menu, a dialog)
//   I  …and open the layers inside it, by the pointer and the keyboard (a menu over a menu, a menu over a dialog). The
//      keys this presses may close the scene's own layer, so a state with I is the last one of its entry.
//   E  the list is at its end: its last row is not under the dock
//   H  on a screen with no hover, every action is in sight (the touch pass only)
// A page's first state carries the whole walk; the states after it are the same page with other content or one thing open.
const MAIN = "LKTRSH";
export const PLAN = [
  { scene: "work-list", name: "Work's list (side bar)", states: { list: MAIN, "folder-menu": "O", "many-long": "LRs", "many-long-end": "E", empty: "R", "whats-new-1": "OR", "new-session": "OR" } },
  { scene: "chat-list", name: "the Chat list (side bar)", states: { list: MAIN, "many-long": "LRs", "many-long-end": "E", empty: "R" } },
  { scene: "home-grid", name: "Home (every card)", states: { top: MAIN, end: "LR" }, reach: homeCardReach },
  { scene: "home-every-card", name: "Home with the dock", states: { cards: "LRsH", "cards-end": "LE" }, passes: "AB", reach: homeCardReach },
  { scene: "home-library", name: "Home's Cards library (a dialog)", states: { library: "OR" }, passes: "AB" },
  { scene: "home-opened", name: "Home, a card opened", states: Object.fromEntries(["needs", "recent", "running", "token", "work", "chats", "pips", "folders", "clock", "weather", "note", "widgets", "artifacts"].map((c) => [c, "LR"])), passes: "A", fixed: 300, widths: [300, 700] },
  { scene: "home-notes", name: "Notes on Home", states: { list: "LR", "a-note": "LKRs", "a-note-menu": "O", "choose-a-pin": "R", card: "LR" }, passes: "AB", fixed: 300, widths: [300, 440, 700] },
  { scene: "home-empty", name: "Home, nothing yet", states: { empty: "LR" }, passes: "A" },
  { scene: "home-answers", name: "Home's cards that ask", states: { cards: "LRs" }, passes: "AB", reach: homeCardReach },
  { scene: "library-tab", name: "the Library (side bar)", states: { list: MAIN, widgets: "LR", images: "LR", videos: "LR", files: "LRs", "kind-menu": "O", "maker-menu": "O", "more-menu": "O", "many-long": "LRs", "many-long-end": "E", empty: "R", "home-top-row": "R" } },
  { scene: "library-page", name: "the Library (editor tab)", states: { list: MAIN, widgets: "LR", images: "LR", videos: "LR", files: "LRs", "list-end": "LE" } },
  { scene: "work-chat", name: "a Work session", states: { "running-queue": MAIN, approval: "LRs" }, extra: "work", prepare: workHost },
  // The model picker (media/shared/modelpicker.js) on each surface: its connections and rows, Claude Code's rows, a search,
  // twelve connections, and the Sub-agents tab.
  { scene: "work-model-menu", name: "a Work session's model picker and agent map", states: { menu: "O", "menu-claude": "O", "menu-search": "O", "menu-many": "O", "sub-agents": "O", "sub-agents-models": "O", "sub-agents-page": "O", "sub-agents-page-custom": "O", "agent-map": "OR", "agent-map-opened": "OR" }, passes: "AB" },
  // (The picker alone in a short and a tall window, at the editor's font sizes, and in forced colours.)
  { scene: "work-model-menu", name: "a Work session's model picker and agent map", states: { menu: "O", "menu-claude": "O", "menu-search": "O", "menu-many": "O", "sub-agents": "O", "sub-agents-models": "O", "sub-agents-page": "O", "sub-agents-page-custom": "O" }, passes: "CDE" },
  { scene: "chat-files", name: "a chat's file cards", states: { "work-files": "LKR", "chatdgc-files": "LKR" }, passes: "AB", extra: "files", prepare: workHost },
  { scene: "chatdgc", name: "ChatDGC", states: { "a-chat": MAIN, "model-picker": "O", "model-picker-claude": "O", "library-artifacts": "LRs" }, extra: "chatdgc" },
  { scene: "pips-list", name: "the Pips list", states: { list: MAIN, "filter-menu": "O", "new-pip": "OR", "pips-settings": "LRs", empty: "R", welcome: "OR", many: "LRs", "many-end": "E" }, split: true },
  { scene: "pips-chat", name: "a Pip's chat and page", states: { "chat-ask": MAIN, "chat-ready": "LR", "level-menu": "O", "model-menu": "O", "model-menu-claude": "O", "model-menu-sub-agents": "O", "model-menu-sub-agents-own": "O", "model-menu-sub-agents-page": "O", "pip-chat": "LKR", page: "LKRs", "page-runs": "LR" }, split: true },
  { scene: "pip-chat", name: "a Pip's chat (long words)", states: { chat: "LRsH" }, passes: "AB", split: true, extra: "pip" },
  { scene: "pip-held-cards", name: "a Pip's held steps", states: null, ops: "R", passes: "A", split: true },
  { scene: "pip-computer", name: "a Pip's computer tab", states: { screen: MAIN } },
  { scene: "settings", name: "Settings", states: { general: MAIN, ...Object.fromEntries(["models", "web", "chatdgc", "memory", "voice", "running", "usage", "security", "plugins", "mcp", "dev"].map((s) => [s, "LR"])) } },
  { scene: "notes-tab", name: "a note in its own tab", states: { "a-note": MAIN }, passes: "AB" },
  { scene: "stress-lists", name: "lists of 200 with awkward names", states: { "work-200": "LRs", "work-200-end": "LE", "chat-200": "LRs", "chat-200-end": "LE", "library-200": "LRs", "library-200-end": "LE", "work-no-dock-end": "LE" }, passes: "AB", widths: [440, 300, 1000] },
  { scene: "whats-new", name: "What's new (a dialog)", states: { "moving-1": "ORs", ...Object.fromEntries([2, 3, 4, 5, 6, 7, 8].map((k) => [`moving-${k}`, "OR"])), ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8].map((k) => [`still-${k}`, "R"])) }, passes: "ABCE" },
  { scene: "stress-chats", name: "chats with awkward words", states: { "work-long-words": "Rs", "chatdgc-long-words": "Rs" }, passes: "A" },
  // A layer the scene opens itself, with the layers inside it (each ends its entry: see I above).
  ...[["work-list", "Work's list (side bar)", "folder-menu"], ["work-list", "Work's list (side bar)", "whats-new-1"], ["work-list", "Work's list (side bar)", "new-session"], ["home-library", "Home's Cards library (a dialog)", "library"],
    ["work-model-menu", "a Work session's model picker and agent map", "menu"], ["work-model-menu", "a Work session's model picker and agent map", "sub-agents-models"],
    ["work-model-menu", "a Work session's model picker and agent map", "sub-agents-page"], ["home-notes", "Notes on Home", "a-note-menu"]]
    .map(([scene, name, state]) => ({ scene, name, states: { [state]: "I" }, passes: "A" })),
  ...[["pips-list", "the Pips list", "new-pip"], ["pips-list", "the Pips list", "filter-menu"], ["pips-chat", "a Pip's chat and page", "level-menu"], ["pips-chat", "a Pip's chat and page", "model-menu"],
    ["pips-chat", "a Pip's chat and page", "model-menu-sub-agents-page"]]
    .map(([scene, name, state]) => ({ scene, name, states: { [state]: "I" }, passes: "A", split: true })),
];

/** The passes over a page. Each opens the scene once and, in every state the plan names, sets the page to each size in
 *  turn. `first`: the size that carries the whole walk (keyboard, labels, sweep); at the others only L, R, O and E run.
 *    A  dark, the five widths at 760 tall                    B  light, 300×640 and 700×800
 *    C  dark, a short and a tall window (440×480, 700×1000): layers only
 *    D  the editor's font at 18 px and at 12 px (dark, 440)   E  forced colours and high contrast (440): layers and rest
 *    F  a touch screen, no hover (440): H only */
export const PASSES = {
  A: { theme: "dark", open: 440, sizes: [[440, 760], [300, 760], [360, 760], [700, 760], [1000, 760]], first: true },
  B: { theme: "light", open: 300, sizes: [[300, 640], [700, 800]], only: "LROE" },
  C: { theme: "dark", open: 440, sizes: [[440, 480], [700, 1000]], only: "LO", variant: "short and tall" },
  D: { theme: "dark", open: 440, sizes: [[440, 760]], only: "LRO", fonts: [18, 12], variant: "font" },
  E: { theme: "dark", open: 440, sizes: [[440, 760]], only: "LRO", forced: true, variant: "forced colours" },
  F: { theme: "dark", open: 440, sizes: [[440, 760]], only: "H", touch: true, variant: "touch" },
};
/** A scene whose page is the side bar under 600 px and an editor tab above (the Pips view) is opened once for each. */
export const SPLIT = { side: { open: 300, sizes: [[300, 760], [360, 760], [440, 760]] }, tab: { open: 700, sizes: [[700, 760], [1000, 760]] } };

/** Layers a pointer or the keyboard opens another way than a press on a control: a typed "@" or "/" in a prompt box. */
const typed = (name, box, ch) => ({ name: `“${ch}” typed in ${name}`, anchor: box, context: true,
  open: async (page) => { await page.evaluate((sel) => window.__la.all(sel)[0]?.focus(), box); await page.keyboard.type(ch); },
  close: async (page) => { await page.keyboard.press("Escape"); await page.keyboard.press("Backspace"); await page.keyboard.press("Escape"); } });
export const EXTRA = {
  work: [typed("Work's prompt box", "#input", "/"), typed("Work's prompt box", "#input", "@"), typed("Work's prompt box", "#input", "$")],
  chatdgc: [typed("ChatDGC's prompt box", "#cd-input", "/"), typed("ChatDGC's prompt box", "#cd-input", "@")],
  pip: [typed("a Pip's prompt box", "#chat-input, #chat-form textarea, #chat-form [contenteditable='true']", "@"), typed("a Pip's prompt box", "#chat-input, #chat-form textarea, #chat-form [contenteditable='true']", "/")],
  files: [{ name: "a right-click on a file card", anchor: "[data-file-card]", context: true, open: async (page) => { const r = await page.evaluate(() => window.__la.rectOf("[data-file-card]")); if (r) await page.mouse.click(r.l + 14, r.t + r.h / 2, { button: "right" }); } }],
};
