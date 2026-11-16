// Every screen the visual polish pass walks (test/render-polish-sweep.mjs), each opened from the scenes the browser
// tests already use: the side bar (Home and its cards, Work, Chat, Pips), a Work session's tab, ChatDGC, a Pip's chat
// and page, Settings, Notes, and their dialogs and menus. A scene is (browser, { width, theme: "dark" | "light",
// touch }, visit): it calls visit(state, page, options) while each state is on screen. Not a *.test.mjs file.
import { openDock, DOCK_SESSIONS } from "./dock-scene.mjs";
import { openGrid, EVERY, LISBON, THIRTY_FOLDERS, NOTES as OLD_NOTES } from "./home-grid-scene.mjs";
import { homeState, SESSIONS, CHATS } from "./home-scene.mjs";
import { openCards } from "./home-cards-scene.mjs";
import { sample } from "./notes-sample.mjs";
import { openRunningTurn, openChatDgc } from "./dgc-look-scene.mjs";
import { openMapScene } from "./agent-map-scene.mjs";
import { openLibrary, ITEMS } from "./chat-scene.mjs";
import { openOnePips, GST, LIME_DIR } from "./one-pips-scene.mjs";
import { openChat as openPipChat } from "./pip-chat-scene.mjs";
import { openSettings, DEV_TABLE } from "./settings-scene.mjs";
const DEV = { dev_limits_table: DEV_TABLE, dev_tools_capable: true };
import { openNoteTab } from "./notes-tab-scene.mjs";
import { openLibraryTab, LIB_ARTIFACTS } from "./library-scene.mjs";
import { openCard, HOLDS } from "./pip-cards-scene.mjs";

const modern = (theme) => `${theme}-modern`;
const settle = (page, ms = 160) => page.evaluate((n) => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, n)))), ms);
const LONG = "A session with a name so long that it cannot fit on one line of a narrow side bar, whatever the width";
/** Many Work sessions, some with long names, one running, one waiting. */
export const MANY_SESSIONS = Array.from({ length: 28 }, (_, k) => ({ id: `202611${String(10 + (k % 5)).padStart(2, "0")}-1015${String(k).padStart(2, "0")}-m${k}`, path: `/s/m${k}.json`,
  name: k % 3 === 0 ? `${LONG} (${k})` : k % 3 === 1 ? `Short ${k}` : "", preview: k % 3 === 2 ? `Explain in one line what the function on line ${k} of src/app.js returns, and why it matters` : "", when: `2026-11-${String(13 - (k % 9)).padStart(2, "0")} 10:15`, count: 3 + k,
  open: k === 1, running: k === 2, waiting: k === 4 }));
/** Scrolls every box that scrolls to its end (and back with `to: 0`). */
const scrollAll = (page, to = "end") => page.evaluate((where) => { const walk = (root) => { for (const n of root.querySelectorAll("*")) { const s = getComputedStyle(n); if (/auto|scroll/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 24) n.scrollTop = where === "end" ? n.scrollHeight : where === "mid" ? Math.round((n.scrollHeight - n.clientHeight) / 2) + 7 : 0; if (n.shadowRoot) walk(n.shadowRoot); } }; walk(document); }, to);
const card = (id, where = ".hc-grid") => `${where} .hc-card[data-card="${id}"]`;
const ALL_CARDS = [...EVERY, "widgets", "artifacts"];

export const SCENES = {
  // ---- Home -----------------------------------------------------------------------------------------------------------
  "home-grid": async (b, { width, theme, touch }, visit) => {
    const x = await openGrid(b, { width, theme: modern(theme), layout: ALL_CARDS, settings: { clock: { zones: ["Asia/Tokyo", "America/Los_Angeles", "America/Buenos_Aires"] }, weather: { place: LISBON, unit: "c" } }, seed: sample(), height: 900, touch,
      folders: { choice: "", window: THIRTY_FOLDERS[0], rows: THIRTY_FOLDERS.slice(0, 9) }, news: [{ id: DOCK_SESSIONS[1].id, at: Date.now() - 60000, preview: "Done: the tide pools piece is 118 words." }] });
    try { await x.rest(500); await visit("top", x.page);
      await scrollAll(x.page, "mid"); await x.rest(300); await visit("middle", x.page, { focus: false });
      await scrollAll(x.page, "end"); await x.rest(300); await visit("end", x.page, { focus: false });
    } finally { await x.close(); }
  },
  "home-opened": async (b, { width, theme, touch }, visit) => {
    // Each card opened (a Small card opens: the side bar's narrow width; the page is then made the width asked).
    for (const id of ALL_CARDS.filter((c) => c !== "quick")) {
      const x = await openGrid(b, { width: 300, theme: modern(theme), layout: ALL_CARDS, settings: { clock: { zones: ["Asia/Tokyo", "America/Los_Angeles", "America/Buenos_Aires"] }, weather: { place: LISBON, unit: "c" } }, seed: sample(), height: 900, touch,
        folders: { choice: "", window: THIRTY_FOLDERS[0], rows: THIRTY_FOLDERS.slice(0, 9) } });
      try { await x.page.locator(card(id)).scrollIntoViewIfNeeded(); await x.page.click(card(id), { position: { x: 12, y: 8 } }); await x.rest(450);
        if (width !== 300) await x.resize(width, 900);
        await visit(id, x.page, { scope: "#home-hub" });
        await scrollAll(x.page, "end"); await x.rest(250); await visit(`${id}-end`, x.page, { scope: "#home-hub", focus: false, hover: false });
      } finally { await x.close(); }
    }
  },
  "home-library": async (b, { width, theme, touch }, visit) => {
    const x = await openGrid(b, { width, theme: modern(theme), layout: ["needs", "recent", "clock"], height: 800, touch });
    try { await x.page.click(".hc-cards-btn"); await x.rest(600); await visit("library", x.page, { scope: "dialog.hc-library" });
      await scrollAll(x.page, "end"); await x.rest(250); await visit("library-end", x.page, { scope: "dialog.hc-library", focus: false });
    } finally { await x.close(); }
  },
  "home-empty": async (b, { width, theme, touch }, visit) => {
    const x = await openGrid(b, { width, theme: modern(theme), layout: ALL_CARDS, state: homeState("quiet"), sessions: [], usage: null, folders: { choice: "", window: null, rows: [] }, widgets: [], artifacts: [], height: 900, touch });
    try { await x.send({ type: "chatdgc_list", available: true, items: [], open: [], answering: [] }); await x.rest(400); await visit("empty", x.page); await scrollAll(x.page, "end"); await x.rest(250); await visit("empty-end", x.page, { focus: false, hover: false }); } finally { await x.close(); }
  },
  "home-answers": async (b, { width, theme, touch }, visit) => {
    const x = await openCards(b, { width, theme: modern(theme), touch, height: 1100 });
    try { await visit("cards", x.page); await scrollAll(x.page, "end"); await x.settle(); await visit("cards-end", x.page, { focus: false }); } finally { await x.close(); }
  },
  "home-notes": async (b, { width, theme, touch }, visit) => {
    const OPEN = ".hc-open .hc-card";
    let x = await openGrid(b, { width: 300, theme: modern(theme), layout: ["note", "clock"], seed: sample(), notesOptions: { iterations: 1500 }, touch });
    try { await x.page.click(`${card("note")} .nt-openapp`); await x.rest(300); if (width !== 300) await x.resize(width, 900);
      await visit("list", x.page, { scope: "#home-hub" });
      await x.page.click(`${OPEN} .hc-note-row[data-note="ferry1"]`); await x.rest(400); await visit("a-note", x.page, { scope: "#home-hub" });
      await x.page.click(`${OPEN} .nt-more`).catch(() => {}); await x.rest(250); await visit("a-note-menu", x.page, { focus: false, hover: false }); await x.page.keyboard.press("Escape"); await x.rest(150);
      await x.page.click(`${OPEN} .hc-note-all`).catch(() => {}); await x.rest(250);
      await x.page.click(`${OPEN} .hc-note-row[data-note="wifi01"]`); await x.rest(300); await x.page.click(`${OPEN} .nt-lock`); await x.rest(300);
      await visit("choose-a-pin", x.page, { scope: "#home-hub" });
      for (const d of "48214821") { await x.page.keyboard.press(d); await x.rest(120); } await x.rest(700);
      await visit("locked-note-open", x.page, { scope: "#home-hub" });
      await x.page.keyboard.press("Control+Alt+l"); await x.rest(400); await visit("locked", x.page, { scope: "#home-hub" });
    } finally { await x.close(); }
    // The Notes card as it stands on Home (Small, Medium, Large by the width), and choosing a PIN from it.
    x = await openGrid(b, { width, theme: modern(theme), layout: ["note", "clock", "weather"], seed: sample(), notesOptions: { iterations: 1500 }, touch, settings: { weather: { place: LISBON } } });
    try { await x.rest(300); await visit("card", x.page);
      if (width >= 440) { const row = x.page.locator(`${card("note")} .hc-note-row[data-note="wifi01"]`); if (await row.count()) { await row.click(); await x.rest(350); await visit("card-a-note", x.page);
        const lock = x.page.locator(`${card("note")} .nt-lock`); if (await lock.count()) { await lock.click(); await x.rest(350); await visit("card-choose-a-pin", x.page); } } }
    } finally { await x.close(); }
  },
  // ---- Work: the side bar's list, the Project Folder dropdown -----------------------------------------------------------
  "work-list": async (b, { width, theme, touch }, visit) => {
    let x = await openDock(b, { tab: "work", width, height: 760, theme: modern(theme), answering: [CHATS[1].id], touch });
    try { await x.settle(); await visit("list", x.page);
      if (!touch) { await x.page.hover("#sessions-list .session-row"); await x.page.click("#sessions-list .session-row .session-more"); await x.settle(); await x.page.waitForTimeout(300); await visit("row-menu", x.page, { hover: false, focus: false }); await x.page.keyboard.press("Escape"); await x.settle(); }
      await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", folders: { choice: THIRTY_FOLDERS[3].folder, window: THIRTY_FOLDERS[0], rows: THIRTY_FOLDERS } }); await x.settle();
      await x.page.click("#sessions-folder-pick"); await x.settle(); await x.page.waitForTimeout(900); await visit("folder-menu", x.page);
      await x.page.evaluate(() => { const l = document.querySelector(".dgc-folder-list"); l.scrollTop = 173; }); await x.page.waitForTimeout(300); await visit("folder-menu-scrolled", x.page, { focus: false });
      await x.page.evaluate(() => { const l = document.querySelector(".dgc-folder-list"); l.scrollTop = l.scrollHeight; }); await x.page.waitForTimeout(300); await visit("folder-menu-end", x.page, { focus: false, hover: false });
    } finally { await x.close(); }
    x = await openDock(b, { tab: "work", width, height: 760, theme: modern(theme), sessions: MANY_SESSIONS, touch });
    try { await x.settle(); await visit("many-long", x.page); await scrollAll(x.page, "mid"); await x.settle(); await visit("many-long-middle", x.page, { focus: false }); await scrollAll(x.page, "end"); await x.settle(); await visit("many-long-end", x.page, { focus: false }); } finally { await x.close(); }
    x = await openDock(b, { tab: "work", width, height: 760, theme: modern(theme), sessions: [], pins: [], dock: false, state: homeState("quiet"), touch });
    try { await x.settle(); await visit("empty", x.page); } finally { await x.close(); }
    // What's new (the dialog the side bar shows once a release), each of its slides; and New session's dialog.
    x = await openDock(b, { tab: "work", width, height: 760, theme: modern(theme), touch });
    try { await x.send({ type: "whatsNew", auto: true, release: "0.52" }); await x.page.waitForSelector("#whats-new:not([hidden])"); await x.page.waitForTimeout(500);
      for (let k = 0; k < 6; k++) { await visit(`whats-new-${k + 1}`, x.page, { scope: "#whats-new", hover: false, focus: k === 0 }); const next = x.page.locator("#whats-new button", { hasText: /^Next$/ }); if (!(await next.count())) break; await next.click(); await x.page.waitForTimeout(450); }
    } finally { await x.close(); }
    x = await openDock(b, { tab: "work", width, height: 760, theme: modern(theme), touch });
    try { await x.send({ type: "sessions_list", items: DOCK_SESSIONS, error: "", folders: { choice: "", window: THIRTY_FOLDERS[0], rows: THIRTY_FOLDERS.slice(0, 6) } }); await x.settle();
      const btn = x.page.locator("#sessions-new, #btn-new-session, [data-act='new-session']").first(); if (await btn.count()) { await btn.click(); await x.page.waitForTimeout(500); if (await x.page.locator(".new-session-dialog").count()) await visit("new-session", x.page, { scope: ".new-session-dialog" }); }
    } finally { await x.close(); }
  },
  "chat-list": async (b, { width, theme, touch }, visit) => {
    const x = await openDock(b, { tab: "chat", width, height: 760, theme: modern(theme), answering: [CHATS[1].id], touch });
    try { await x.settle(); await visit("list", x.page);
      const many = Array.from({ length: 30 }, (_, k) => ({ id: `chat_m${k}`, title: k % 2 ? `${LONG} (${k})` : `Chat ${k}`, preview: k % 3 ? "A preview line that is long enough to need more room than the row has for it, by some way." : "", updated_at: `2026-11-${String(13 - (k % 9)).padStart(2, "0")}T09:00:00Z`, pinned: k < 2 }));
      await x.send({ type: "chatdgc_list", available: true, items: many, open: ["chat_m1"], answering: ["chat_m3"] }); await x.settle(); await visit("many-long", x.page);
      await scrollAll(x.page, "end"); await x.settle(); await visit("many-long-end", x.page, { focus: false });
      await x.send({ type: "chatdgc_list", available: true, items: [], open: [], answering: [] }); await x.settle(); await visit("empty", x.page);
    } finally { await x.close(); }
  },
  // ---- the Library tab (15 Nov): its rows, each filter's menu, a filter that finds nothing, an empty Library ------------------
  "library-tab": async (b, { width, theme, touch }, visit) => {
    let x = await openLibraryTab(b, { width, theme: modern(theme), touch });
    try { await visit("list", x.page);
      await x.menu("kind"); await visit("kind-menu", x.page, { focus: false, hover: false }); await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(200);
      await x.menu("maker"); await visit("maker-menu", x.page, { focus: false, hover: false });
      await x.pick("maker", "Rent or buy: the numbers"); await x.pick("kind", "Dashboards"); await visit("long-filters-nothing-found", x.page);
      await x.pick("kind", "All"); await x.pick("maker", "Anyone");
      await x.page.click("#library-more"); await x.page.waitForTimeout(350); await visit("more-menu", x.page, { focus: false, hover: false }); await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(200);
      // Each of its own tabs (Library v2): Widgets, Images, Videos, Files.
      for (const tab of ["widgets", "images", "videos", "files"]) { await x.libTab(tab); await visit(tab, x.page); }
      await x.libTab("artifacts");
      await scrollAll(x.page, "end"); await x.settle(); await visit("list-end", x.page, { focus: false });
    } finally { await x.close(); }
    // Many things with long names, from makers with long names.
    const many = Array.from({ length: 60 }, (_, k) => ({ ...LIB_ARTIFACTS[k % LIB_ARTIFACTS.length], id: "ar_" + String(k).padStart(16, "a"), title: k % 2 ? `${LONG} (${k})` : `Item ${k}`,
      ...(k % 3 ? {} : { made_by: { kind: "pip", id: "pip_" + "9".repeat(32), name: "Checkout smoke tests, every night at two" } }) }));
    x = await openLibraryTab(b, { width, theme: modern(theme), touch, artifacts: many });
    try { await visit("many-long", x.page); await scrollAll(x.page, "end"); await x.settle(); await visit("many-long-end", x.page, { focus: false }); } finally { await x.close(); }
    x = await openLibraryTab(b, { width, theme: modern(theme), touch, artifacts: [], files: [], images: [], videos: [], widgets: [] });
    try { await visit("empty", x.page); } finally { await x.close(); }
    // Home's top row: Library beside Cards, and beside Back while a card is open.
    const g = await openGrid(b, { width, theme: modern(theme), layout: ["needs", "recent", "clock"], height: 700, touch });
    try { await g.rest(300); await visit("home-top-row", g.page, { scope: "#home-hub .hc-head" });
      await g.page.click(card("clock"), { position: { x: 12, y: 8 } }).catch(() => {}); await g.rest(400); await visit("home-top-row-card-open", g.page, { scope: "#home-hub .hc-head" });
    } finally { await g.close(); }
  },
  // ---- a Pip's held steps: each card with its answers (15 Nov: Always allow on every card; finding 45: the site card) --------
  "pip-held-cards": async (b, { width, theme, touch }, visit) => {
    const where = width >= 600 ? "tab" : "side";
    for (const kind of Object.keys(HOLDS)) { const x = await openCard(b, kind, { width, theme, where, touch });
      try { await x.p.waitForTimeout(200); await visit(kind, x.p, { hover: false });
        const details = await x.p.evaluateHandle(() => (window.__pipsRoot || document).querySelector("[data-computer-card] details > summary")); if (details.asElement()) { await details.asElement().click().catch(() => {}); await x.p.waitForTimeout(200); await visit(`${kind}-details`, x.p, { hover: false, focus: false }); }
      } finally { await x.close(); } }
  },
  // ---- a Work session's tab ---------------------------------------------------------------------------------------------
  "work-chat": async (b, { width, theme }, visit) => {
    let x = await openRunningTurn(b, { width, height: 760, theme: modern(theme), approval: false });
    try { await visit("running-queue", x.page); } finally { await x.page.close(); }
    x = await openRunningTurn(b, { width, height: 760, theme: modern(theme), approval: true });
    try { await visit("approval", x.page); } finally { await x.page.close(); }
  },
  "work-model-menu": async (b, { width, theme }, visit) => {
    const SPARE = `provider_${"c".repeat(32)}`, OPEN = `provider_${"d".repeat(32)}`;
    const ROUTES = [{ key: `provider_${"a".repeat(32)}`, label: "Ollama", kind: "native", base_url: "http://127.0.0.1:11434/v1", model: "qwen3.8:27b" }, { key: SPARE, label: "Spare GPU box", kind: "native", base_url: "https://spare.example/v1", model: "gpt-oss:120b" },
      { key: OPEN, label: "Ollama Cloud", kind: "native", base_url: "https://ollama.com", model: "", allModels: true }, { key: "subscription_claude", label: "Claude Code", kind: "subscription", engine: "claude" }, { key: "subscription_codex", label: "Codex", kind: "subscription", engine: "codex" }];
    const AGENTS = { offered: true, own: false, model: "qwen3-coder", base_url: "", settings_model: "qwen3-coder", settings_base_url: "", router: false };
    const models = { type: "models", ids: ["qwen3.8:27b", "qwen3-coder", "deepseek-v4.1-flash:cloud", "glm-5.3:cloud", "a-model-with-a-very-long-name-that-goes-on:120b-instruct-q8_0"], current: "qwen3.8:27b", routes: ROUTES, currentRouteKey: ROUTES[0].key, supportsEffort: true,
      fallback: { offered: true, model: "", base_url: "", engine: "", route_base: "http://127.0.0.1:11434/v1" }, agents: AGENTS };
    const scene = await openMapScene(b, { width, height: 760, theme: modern(theme), open: false, capabilities: { agents_model: 1, model_fallback: 1 } });
    const { page, post } = scene;
    try {
      await page.click("#btn-model"); await post(models); await page.waitForSelector("#modelmenu .model-tabs"); await page.waitForTimeout(200); await visit("menu", page);
      await page.click("#modelmenu [data-model-tab='agents']"); await page.waitForSelector("#modelmenu [data-agents-same]"); await page.waitForTimeout(200); await visit("sub-agents", page);
      await page.click('#modelmenu [data-agents-provider="1"]'); await post({ type: "providerModels", id: SPARE, ids: ["gpt-oss:120b", "own-coder", "qwen3-coder:30b", "a-model-with-a-very-long-name-that-goes-on:120b-instruct-q8_0"] });
      await page.waitForSelector("#modelmenu [data-agents-model]"); await page.waitForTimeout(200); await visit("sub-agents-models", page);
      await page.keyboard.press("Escape"); await page.waitForTimeout(150); await page.keyboard.press("Escape");
      await page.click("#agents-pill"); await page.waitForTimeout(350); await visit("agent-map", page);
      const row = page.locator(".agent-row, [data-agent-id]").first(); if (await row.count()) { await row.click().catch(() => {}); await page.waitForTimeout(300); await visit("agent-map-opened", page, { focus: false }); }
    } finally { await page.close(); }
  },
  // ---- ChatDGC ----------------------------------------------------------------------------------------------------------
  "chatdgc": async (b, { width, theme }, visit) => {
    const x = await openChatDgc(b, { width, height: 760, theme: modern(theme) });
    try { await visit("a-chat", x.page);
      for (const [name, sel] of [["model-menu", "#cd-model"], ["plus-menu", "#cd-plus, #cd-attach, .cd-plus"], ["more-menu", "#cd-more, .cd-more"]]) { const btn = x.page.locator(sel).first(); if (await btn.count() && await btn.isVisible()) { await btn.click().catch(() => {}); await x.page.waitForTimeout(300); await visit(name, x.page, { focus: false, hover: false }); await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(150); } }
    } finally { await x.page.close(); }
    const l = await openLibrary(b, { width, height: 700, theme: modern(theme) });
    try { await l.send({ type: "library", files: [], total: 0, next: null, counts: {} }); await l.send({ type: "widgetsOffered", on: true }); await l.send({ type: "artifactsOffered", on: true }); await l.send({ type: "view", view: "artifacts" }); await l.send({ type: "artifacts", items: [...ITEMS] });
      await settle(l.page); await visit("library-artifacts", l.page); } finally { await l.page.close(); }
  },
  // ---- Pips -------------------------------------------------------------------------------------------------------------
  "pips-list": async (b, { width, theme }, visit) => {
    const where = width >= 600 ? "tab" : "side", opts = { theme: modern(theme), width, height: 760, where };
    const unread = { [GST]: { id: "msg_" + "7".repeat(32), latest: "Tonight's check found 3 things. Two are new, and one is back from Tuesday." } };
    let x = await openOnePips(b, { ...opts, scene: { fix: "ask", unread } });
    try { await visit("list", x.page);
      await x.click("#pips-filter"); await x.page.waitForTimeout(600); await visit("filter-menu", x.page, { focus: false }); await x.page.keyboard.press("Escape"); await x.page.waitForTimeout(300);
      await x.click("#simple-new"); await x.waitIn("#review-root .dialog"); await x.page.waitForTimeout(300); await visit("new-pip", x.page, { hover: false });
    } finally { await x.close(); }
    x = await openOnePips(b, { ...opts, scene: { fix: "ask" } });
    try { await x.click("#pips-settings-open"); await x.page.waitForTimeout(900); await visit("pips-settings", x.page);
      await scrollAll(x.page, "end"); await x.page.waitForTimeout(250); await visit("pips-settings-end", x.page, { focus: false, hover: false }); } finally { await x.close(); }
    x = await openOnePips(b, { ...opts, scene: { empty: true } });
    try { await visit("empty", x.page); } finally { await x.close(); }
    const pid = (c) => "pip_" + c.repeat(32);
    x = await openOnePips(b, { ...opts });
    try { await x.send({ type: "pipsWelcome", auto: true, welcome: { had_pips: true, folders: [{ folder: "lime_tiles", pips: [{ id: pid("c"), name: "GST watchdog" }, { id: pid("d"), name: "ERP daily audit" }] }, { folder: "shop-frontend-and-checkout", pips: [{ id: pid("8"), name: "Checkout smoke tests, every night at two" }] }],
        personal: [{ id: pid("b"), name: "Mornings" }, { id: pid("e"), name: "Garden notes" }], do_it_all: [{ id: pid("b"), name: "Mornings" }] } });
      await x.page.waitForSelector("#pips-welcome:not([hidden])", { timeout: 4000 }); await x.page.waitForTimeout(400); await visit("welcome", x.page, { hover: false }); } catch { /* the dialog is the side bar's */ } finally { await x.close(); }
    // Many Pips, with new things to read, numbers, pins and long names (the older scene's list).
    const m = await openPipChat(b, { width, height: 760, theme, where, many: true, home: true });
    try { await m.p.evaluate(() => window.postMessage({ type: "dock", pinned: ["pip:pip_" + "3".repeat(32), "pip:pip_" + "4".repeat(32)] }, "*")); await m.p.waitForTimeout(400); await visit("many", m.p);
      await scrollAll(m.p, "end"); await m.p.waitForTimeout(250); await visit("many-end", m.p, { focus: false }); } finally { await m.close(); }
  },
  "pips-chat": async (b, { width, theme }, visit) => {
    const where = width >= 600 ? "tab" : "side", opts = { theme: modern(theme), width, height: 760, where };
    for (const fix of ["ask", "ready"]) { const x = await openOnePips(b, { ...opts, scene: { fix } });
      try { await x.openPip(GST); await x.waitIn(fix === "ask" ? ".pip-found-ask" : "[data-project-change]"); await x.page.waitForTimeout(200); await visit(`chat-${fix}`, x.page);
        if (fix === "ask") { await x.click("#chat-level"); await x.waitIn(".composer-level-menu"); await x.page.waitForTimeout(200); await visit("level-menu", x.page, { focus: false, hover: false }); }
      } finally { await x.close(); } }
    // Its model menu with the two tabs (14 Nov): a DGC that runs sub-agents for a Pip (Pips API 97).
    { const x = await openOnePips(b, { ...opts, api: 97, scene: { sub: true, waiting: false, fix: "none" } });
      try { await x.openPip(GST); await x.page.waitForTimeout(300); await x.click("#chat-model"); await x.waitIn(".composer-model-menu .model-tabs"); await x.page.waitForTimeout(250); await visit("model-menu", x.page, { focus: false, hover: false });
        await x.click('[data-model-tab="agents"]'); await x.waitIn(".composer-agents"); await x.page.waitForTimeout(200); await visit("model-menu-sub-agents", x.page, { focus: false, hover: false });
      } finally { await x.close(); } }
    // Its page (every section with something in it), from the older scene that fills each; and the pages under it.
    for (const sub of ["", "schedule", "runs", "revisions"]) {
      const p = await openPipChat(b, { settings: true, width, height: 900, where, theme, api: 96 });
      try { await p.p.waitForTimeout(300); if (!sub) await visit("pip-chat", p.p);
        await p.p.evaluate(() => { const root = window.__pipsRoot || document; (root.querySelector('.pip-topbar .pip-menu [data-tab="job"]') || root.querySelector('[data-tab="job"]')).click(); }); await p.p.waitForTimeout(450);
        if (sub) { const there = await p.p.evaluate((t) => { const n = (window.__pipsRoot || document).querySelector(`.pip-page-row[data-tab="${t}"], [data-tab="${t}"]`); if (n) n.click(); return !!n; }, sub); if (!there) continue; await p.p.waitForTimeout(450); }
        const name = sub ? `page-${sub}` : "page";
        await visit(name, p.p); await scrollAll(p.p, "mid"); await p.p.waitForTimeout(250); await visit(`${name}-middle`, p.p, { focus: false });
        await scrollAll(p.p, "end"); await p.p.waitForTimeout(250); await visit(`${name}-end`, p.p, { focus: false, hover: false });
      } finally { await p.close(); } }
  },
  // ---- Settings ---------------------------------------------------------------------------------------------------------
  "settings": async (b, { width, theme }, visit) => {
    for (const section of ["general", "models", "web", "chatdgc", "memory", "voice", "running", "usage", "security", "plugins", "mcp", "dev"]) {
      let x; try { x = await openSettings(b, { width, height: 900, theme, section, extra: section === "dev" ? { ...DEV, dev_mode: true, dev_mode_warned: true, dev_mode_tools: true } : {}, running: section === "running" ? [{ id: "s1", title: LONG, summary: "Waiting for your okay to run npm publish in a folder with a long path", since: "2026-11-14T10:00:00Z", stuck: true, folder: "/home/me/projects/uploads-service" }, { id: "s2", title: "Short", summary: "Running", since: "2026-11-14T11:00:00Z" }] : [] });
        await x.rest(300); await visit(section, x.page); await scrollAll(x.page, "end"); await x.rest(200); await visit(`${section}-end`, x.page, { focus: false, hover: false });
      } finally { await x?.close(); }
    }
  },
  // ---- Notes in its own tab --------------------------------------------------------------------------------------------
  "notes-tab": async (b, { width, theme, touch }, visit) => {
    const x = await openGrid(b, { width: 300, theme: modern(theme), layout: ["note", "clock"], seed: sample(), notesOptions: { iterations: 1500 }, touch });
    try { const tab = await openNoteTab(b, x.notes.store, "ferry1", { width, height: 800, theme: modern(theme) });
      try { await visit("a-note", tab.page); } finally { await tab.close(); } } finally { await x.close(); }
  },
};
