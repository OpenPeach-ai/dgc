// The side bar as the panel builds it (src/panel.ts, media/main.js, media/main.css) with the real Pips bundle and
// faces, in real Chromium: the five tabs (Home, Work, Chat, Library, Pips), Home's cards, and Work's and Chat's lists. A stub
// host answers the Pips control channel from window.__state, which a test may change before the next poll.
// Shared by the side bar's tests and the before/after pictures. Not a *.test.mjs file. No port is opened: the page is
// routed.
import { readFileSync } from "node:fs";
import { build } from "esbuild";

const here = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const bundles = new Map();
/** The page, its scripts and the Pips bundle built from `root` (this tree by default; an older tree for a "before" picture). */
async function sources(root = here) {
  if (bundles.has(root)) return bundles.get(root);
  const scene = await import(`${root}/test/support/options-scene.mjs`);
  const out = await build({ entryPoints: [`${root}/src/pipsClient.js`], bundle: true, write: false,
    format: "iife", outdir: "dist", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
  const made = { ...scene.panelHtml(), themes: scene.THEMES, pipsJs: out.outputFiles.find((f) => f.path.endsWith(".js")).text,
    pipsCss: out.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n"),
    sprite: readFileSync(`${root}/media/pips/plush-bodies.webp`) };
  bundles.set(root, made);
  return made;
}

export const P = "ws_" + "1".repeat(32), Q = "ws_" + "2".repeat(32);
export const pipId = (c) => "pip_" + c.repeat(32);
const listed = (c, name, type, workspace = P) => ({ id: pipId(c), name, pip_type: type, workspace_id: workspace, status: "active", pending_review_count: 0, version: 1 });
const unread = (c, name, type, count, latest, minute, workspace = P) => ({ pip_id: pipId(c), workspace_id: workspace, name, pip_type: type, count, messages: count, posts: 0,
  latest, latest_at: `2026-11-03T10:${String(minute).padStart(2, "0")}:00Z`, latest_message_id: "message_" + c.repeat(32), latest_post_id: null });
const waiting = (c, name, type, n) => { const card = "maildraft_" + String(n).repeat(32); return { id: `email:${card}`, kind: "email", card, pip_id: pipId(c), pip_name: name, pip_type: type,
  workspace_id: P, title: "A reply to send", detail: "", created_at: "2026-11-03T08:00:00.000Z", expires_at: null }; };

/** What the stub DGC answers with. `busy`: two Pips wait for you and six messages are new (a number, dots, a failed run).
    `quiet`: nothing waits and nothing is new. */
export function homeState(kind = "busy") {
  const pips = [listed("a", "Core", "core"), listed("b", "Mail watch", "scout"), listed("c", "Morning brief", "quill"), listed("d", "Garden notes", "lens"),
    listed("e", "Billing review", "rook", Q)];
  if (kind === "quiet") return { list: { [P]: pips.slice(0, 4), [Q]: pips.slice(4) }, unread: { [P]: [], [Q]: [] }, attention: null, digest: [] };
  const items = [waiting("b", "Mail watch", "scout", 1), waiting("b", "Mail watch", "scout", 2)];
  return { list: { [P]: pips.slice(0, 4), [Q]: pips.slice(4) },
    unread: { [P]: [unread("b", "Mail watch", "scout", 3, "Two new mails from your bank, one needs a reply.", 30), unread("c", "Morning brief", "quill", 2, "Five bullets for this morning, each with its link.", 20),
      unread("d", "Garden notes", "lens", 1, "The tomatoes want water tomorrow.", 10)], [Q]: [] },
    attention: { as_of: "2026-11-03T12:00:00.000Z", total: 2, items, truncated: false, counts: { email: 2 }, by_pip: { [pipId("b")]: 2 },
      projects: {} },
    digest: [{ pip_id: pipId("e"), workspace_id: Q, name: "Billing review", pip_type: "rook", scope: "project", status: "active", min_severity: "low", alert_severity: null,
      runs: { succeeded: 0, failed: 1, cancelled: 0 }, skipped_unchanged: 0, new_total: 0, below_threshold: 0, new_findings: [], gone_after_change: 0, alert: false, latest_run_id: null }] };
}

export const SESSIONS = [
  { id: "20261106-101500-a1", path: "/s/a1.json", name: "", preview: "Run the shell command `ls -la src` and tell me in one line what is there", when: "2026-11-06 10:15", count: 5, open: true },
  { id: "20261106-091200-b2", path: "/s/b2.json", name: "Visits page alignment", preview: "", when: "2026-11-06 09:12", count: 12, open: false },
  { id: "20261105-221000-c3", path: "/s/c3.json", name: "", preview: "In one short sentence: what does nextWatering in src/app.js return?", when: "2026-11-05 22:10", count: 7, open: false },
  { id: "20261104-180000-d4", path: "/s/d4.json", name: "Invoice totals round the wrong way", preview: "", when: "2026-11-04 18:00", count: 31, open: false },
];

const PROJECT = "project_" + "a".repeat(32);
export const CHATS = [
  { id: "chat_1", title: "A week in Goa in March", preview: "Three beaches, two day trips and where to eat.", updated_at: "2026-11-06T09:00:00Z", pinned: true },
  { id: "chat_2", title: "Rent or buy: the numbers", preview: "At 8.5% the two cross in year nine.", updated_at: "2026-11-05T09:00:00Z" },
];
export const PROJECTS = [{ id: PROJECT, name: "Goa trip", color: "teal", chats: 2, files: [], memory: "shared" },
  { id: "project_" + "b".repeat(32), name: "House hunt", color: "orange", chats: 5, files: [], memory: "shared" }];
const PROJECT_CHATS = [{ id: "chat_3", title: "Packing list", updated_at: "2026-11-04T09:00:00Z" }, { id: "chat_4", title: "Flights and the ferry", updated_at: "2026-11-03T09:00:00Z" }];

/** Opens the side bar. tab: "home" | "work" | "chat" | "pips", the tab the page's state was left on (Chat comes with two
    projects, the first open); homeShow: what the host kept of Home's Show filter (the page's attribute); saved: the page's
    whole kept state, in place of `tab`. theme: "dark-modern" | "light-modern" | "hc"; tabs: ChatDGC is here (seen before);
    library: Work's Library row; srcRoot: another tree's sources; pages: the host's kept "made" cards, as its attribute's JSON. */
export async function openHome(browser, { state = homeState(), width = 300, height = 760, theme = "dark-modern", homeShow = "", tabs = true, library = true,
  sessions = SESSIONS, tab = "home", saved, grid = false, open = "needs", api = 69, scale = 1, motion = "no-preference", srcRoot, video, pages = "", forced = false, touch = false, clock = null } = {}) {
  const { html, mainJs, markdownJs, themes, pipsJs, pipsCss, sprite } = await sources(srcRoot);
  // video: a folder to record the page into (the pictures' short films), at the page's own size.
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: motion, forcedColors: forced ? "active" : "none", hasTouch: touch,   // (forced: Windows High Contrast; touch: a finger, no pointer)
    ...(video ? { recordVideo: { dir: video, size: { width, height } } } : {}) });
  const page = await context.newPage();
  // clock: the page's timers and Date under the test's hand from the first script on (page.clock.runFor).
  if (clock) await page.clock.install(typeof clock === "object" ? clock : {});
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  // The Pips bundle's own CSS belongs to the Pips page's shadow root (its host's data-style-uri), never to this page.
  const doc = html.replace("</body>", `<script src="/ext/dist/pips.js"></script></body>`);
  await page.route("https://home.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/ext/dist/pips.js") return r.fulfill({ body: pipsJs, contentType: "text/javascript" });
    if (path === "/ext/dist/pips.css") return r.fulfill({ body: pipsCss, contentType: "text/css" });
    if (path === "/ext/media/pips/plush-bodies.webp") return r.fulfill({ body: sprite, contentType: "image/webp" });
    // The extension's own pictures beside them, as the webview serves its media folder (a face's tint mask, a Pip
    // computer's app icons in What's new): read from the tree, never from anywhere else.
    const media = /^\/ext\/media\/([\w./-]+\.(png|webp|svg))$/.exec(path);
    if (media && !media[1].includes("..")) { try { return r.fulfill({ body: readFileSync(`${srcRoot || here}/media/${media[1]}`), contentType: media[2] === "svg" ? "image/svg+xml" : `image/${media[2]}` }); } catch { return r.fulfill({ status: 404, body: "" }); } }
    return r.fulfill({ body: doc, contentType: "text/html" });
  });
  await page.goto("https://home.test/webview/index.html");
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-font-size: 13px; ${themes[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs, initial, kept, withTabs, apiVersion, ids, saved, made]) => {
    const [P, Q] = ids;
    document.documentElement.dataset.chatPlace = "home";
    document.documentElement.dataset.pipsDocumentId = "doc1";
    document.getElementById("pips-host").dataset.styleUri = "/ext/dist/pips.css";
    if (withTabs) document.documentElement.dataset.chatdgcSeen = "1";
    // What the host stamps on the page when Home's Show filter was left on one source (src/pipHomeDismiss.ts).
    if (kept) document.documentElement.dataset.homeShow = kept;
    // What was made and is still on Home, as the host stamps it (src/pipHomeDismiss.ts): the attribute's own JSON.
    if (made) document.documentElement.dataset.homePages = made;
    window.__state = initial; window.__posted = []; window.__saved = saved; window.__answered = []; window.__asking = 0;
    const S = () => window.__state;
    const answers = {
      list_workspaces: () => ({ workspaces: [{ id: P, name: "Your Pips", kind: "personal" }, { id: Q, name: "shop", kind: "git" }], current_workspace_id: Q }),
      list_pips: (r) => ({ pips: S().list[r.workspace_id] || [], total: (S().list[r.workspace_id] || []).length, next_offset: null }),
      get_pip_digest: () => ({ digest: { schema_version: 1, since: "2026-11-03T00:00:00.000Z", until: "2026-11-03T12:00:00.000Z", first: false, due: false, reason: null,
        headline: "Your Pips", pips: S().digest || [], omitted_pips: 0, failed_runs: 0, pending_reviews: 0, pending_setups: 0, truncated: false } }),
      list_pip_attention: () => S().attention || ({ as_of: "2026-11-03T12:00:00.000Z", total: 0, items: [], truncated: false, counts: {}, by_pip: {}, projects: {} }),
      list_pip_unread: (r) => { const pips = S().unread[r.workspace_id] || []; return { workspace_id: r.workspace_id, pips, total: pips.reduce((n, p) => n + p.count, 0) }; },
      mark_pip_read: (r) => { for (const w of Object.keys(S().unread)) S().unread[w] = S().unread[w].filter((p) => p.pip_id !== r.pip_id); return { pip_id: r.pip_id, count: 0 }; },
      // What a card answers by itself (a new Pip, a Pip's change, a visit to a new site): from the state's `setups`
      // (by id), `computers` (by Pip) and the attention list, which loses what was answered. A state with none of
      // them refuses, as a DGC would a thing that is not there.
      get_pip_setup: (r) => (S().setups?.[r.setup_id] ? { setup: S().setups[r.setup_id] } : { __error: "That setup is not here." }),
      accept_pip_setup: (r) => settleSetup(r, "accepted"), reject_pip_setup: (r) => settleSetup(r, "rejected"),
      get_pip_computer: (r) => (S().computers?.[r.pip_id] ? { computer: S().computers[r.pip_id] } : { __error: "It has no computer." }),
      decide_pip_computer_action: (r) => { const all = Object.values(S().computers || {}).flatMap((c) => c.actions), a = all.find((x) => x.id === r.action_id);
        if (!a || a.digest !== r.expected_digest || a.status !== "pending") return { __error: "That changed. Refresh." };
        a.status = r.approve ? "approved" : "rejected"; waitsNoMore(r.action_id); return { action: a }; },
      accept_pip_update: (r) => { waitsNoMore(r.proposal_id); return { pip: { id: r.pip_id } }; },
      reject_pip_update: (r) => { waitsNoMore(r.proposal_id); return { pip: { id: r.pip_id } }; },
      mark_pip_news_seen: (r) => { S().digest = (S().digest || []).filter((p) => !r.pip_ids.includes(p.pip_id)); return { seen: r.pip_ids.map((pip_id) => ({ pip_id, seen_until: r.until })) }; },
      // DGC Browser (Pips API 107): the last links from the state's `browser.recent`, and an open the state may refuse.
      get_dgc_browser_recent: () => ({ links: [], open: false, available: true, reason: "", ...(S().browser?.recent || {}) }),
      open_dgc_browser: (r) => (S().browser?.refuse ? { __error: S().browser.refuse } : { ok: true, kind: "host_profile", weaker: true, url: r.url || "", open: true, view: S().browser?.recent?.view || "window" }),
      // Install Google Chrome (18 Nov): it starts (the card says so), unless the state answers otherwise.
      install_google_chrome: () => S().browser?.installAnswer || { available: false, install: { ...(S().browser?.recent?.install || {}), state: "running", error: "" } },
      // Clear browsing data (Pips API 112): what was ticked is cleared, unless the state refuses it.
      clear_dgc_browser: (r) => (S().browser?.clearRefuse ? { __error: S().browser.clearRefuse }
        : { ok: true, cleared: ["history", "sign_ins", "passwords"].filter((k) => r[k] === true), reopened: S().browser?.recent?.open === true, chrome_account: S().browser?.recent?.chrome_account === true }),
      // The dock's quick look at the Pips working there (Pips API 113): the state's `browser.lanes` and `browser.runsLive`.
      get_dgc_browser_lanes: () => ({ lanes: S().browser?.lanes || [], runs_live: S().browser?.runsLive === true }),
      // The Sites panel (Pips API 113): the state's `browser.sites` / `browser.pips`, changed as DGC would; a site in
      // `browser.refuseSite` is refused.
      get_dgc_browser: () => ({ kind: "host_profile", weaker: true, available: true, reason: "", sites: S().browser?.sites || [], pips: S().browser?.pips || [],
        signing_out: S().browser?.signingOut || [], yours: { open: false, tabs: [{ title: "Bank", url: "https://bank.example/" }], error: "" }, lanes: [] }),
      set_dgc_browser_site: (r) => { const b = S().browser, s = (b?.sites || []).find((x) => x.site === r.site);
        if (!s) return { __error: `You aren't signed in to ${r.site} in DGC Browser.` };
        if (b.refuseSite === r.site) return { __error: "DGC couldn't change that site just now." };
        s.mode = r.mode; s.pips = r.mode === "chosen" ? (r.pips || []).map((id) => ({ pip_id: id, name: (b.pips || []).find((p) => p.pip_id === id)?.name || "" })) : [];
        return { site: s }; },
      sign_out_dgc_browser_site: (r) => { const b = S().browser; if (!(b?.sites || []).some((x) => x.site === r.site)) return { __error: "Not there." };
        b.sites = b.sites.filter((x) => x.site !== r.site); b.signingOut = [...(b.signingOut || []), r.site]; return { site: r.site, sign_out: "waiting" }; },
      seen_dgc_browser_sites: () => { for (const s of S().browser?.sites || []) s.new = false; if (S().browser?.recent) S().browser.recent.new_sites = 0; return { ok: true }; },
    };
    function waitsNoMore(card) { const a = S().attention; if (!a) return;
      for (const list of ["items", "reviews"]) { const at = (a[list] || []).findIndex((i) => i.card === card); if (at < 0) continue;
        const [gone] = a[list].splice(at, 1); a.total--; if (gone.pip_id && a.by_pip[gone.pip_id]) { if (--a.by_pip[gone.pip_id] < 1) delete a.by_pip[gone.pip_id]; } } }
    function settleSetup(r, status) { const s = S().setups?.[r.setup_id];
      if (!s || s.digest !== r.expected_digest || s.status !== "pending") return { __error: "This was changed or answered somewhere else." };
      s.status = status; waitsNoMore(s.id); return { setup: s }; }
    window.__requests = [];
    const connect = () => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsConnection", generation: 1, apiVersion, connected: true, supported: true, enabled: true } }));
    window.acquireVsCodeApi = () => ({ getState: () => window.__saved, setState(next) { window.__saved = JSON.parse(JSON.stringify(next)); }, postMessage(m) {
      window.__posted.push(JSON.parse(JSON.stringify(m)));
      if (m?.type === "pipsReady") { setTimeout(connect, 1); return; }
      // A scene that opens the Pips view on this page answers its requests itself (dock-scene.mjs); the home's own keep theirs.
      if (window.__pipsApp && m?.type === "pipsRequest" && !/^(home-pips|dgc-browser)-/.test(String(m.id))) { window.__pipsApp(m); return; }
      const make = m?.type === "pipsRequest" && answers[m.request.type];
      if (m?.type === "pipsRequest") window.__requests.push(JSON.parse(JSON.stringify(m.request)));
      // (What the home asked and has had answered is noted, so a test can wait for a whole poll.)
      if (make) { window.__asking++; setTimeout(() => { const result = make(m.request), refused = result && result.__error;
        window.dispatchEvent(new MessageEvent("message", { data: refused ? { type: "pipsReply", id: m.id, ok: false, error: { message: refused } } : { type: "pipsReply", id: m.id, ok: true, result } })); window.__answered.push(m.request.type); window.__asking--; }, 2); }
    } });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    connect();
  // (grid: Home as its cards, the way it opens. Without it Home opens with one card opened whole, where the hub's cards
  // are drawn as a list: `open: "needs"` (the default) for what needs you, `open: "recent"` for what is new, which is in
  // Recent only. x.card(id) goes from one to the other.)
  }, [mainJs, markdownJs, state, homeShow, tabs, api, [P, Q], { ...(saved || (tab === "chat" ? { sideTab: "chat", projectsOpen: [PROJECT] } : { sideTab: tab })), ...(grid ? {} : { homeCards: { open } }) }, pages]);
  // The queued messages' row, as the panel loads it on every page (src/panel.ts: messagequeue.css and .js).
  await page.addStyleTag({ content: readFileSync(`${srcRoot || here}/media/messagequeue.css`, "utf8") });
  await page.addScriptTag({ content: readFileSync(`${srcRoot || here}/media/messagequeue.js`, "utf8") });
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  if (sessions) await send({ type: "sessions_list", items: sessions, error: "" });
  if (tabs) {
    await send({ type: "chatdgc_list", available: true, items: CHATS, open: ["chat_1"] });
    await send({ type: "chatdgc_projects", projects: PROJECTS });
    await send({ type: "chatdgc_project_chats", project: PROJECT, items: PROJECT_CHATS });
  }
  // Work's Library row shows once the backend offers outputs; the row itself is what the pictures and the edge need.
  // (Work's Library button is gone since 14 Nov: Library gets a header tab of its own. Kept for a scene that still asks.)
  if (library) await page.evaluate(() => { const button = document.getElementById("work-library"); if (button) button.hidden = false; });
  /** Until the home's Pips have been asked for and answered, whole, and the page has drawn what came. */
  const polled = async (from = 0) => {
    await page.waitForFunction((n) => window.__answered.slice(n).includes("get_pip_digest") && window.__asking === 0, from, { timeout: Number(process.env.DGC_HOME_WAIT_MS) || 30000 });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 30)))));
    // (What a card may answer by itself is read after the list is drawn: that too has been answered and drawn.)
    await page.waitForFunction(() => window.__asking === 0, null, { timeout: 30000 });
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 30)))));
  };
  await polled();
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
  /** The next poll, as the host's "something changed" nudge asks for it; resolves when the page has drawn it. */
  const refresh = async () => { const from = await page.evaluate(() => window.__answered.length); await send({ type: "pipNewsRefresh" }); await polled(from); };
  /** The page's kept state (what a reload hands back), and the tab bar and Home as they are on screen. */
  const kept = () => page.evaluate(() => window.__saved);
  /** Opens another card whole (from the one that is open): "recent" for what is new, "needs" for what needs you. */
  const card = async (id) => { await page.evaluate((which) => { document.querySelector("#home-hub .hc-back")?.click(); const c = document.querySelector(`#home-hub .hc-grid .hc-card[data-card="${which}"]`); (c.querySelector(".hc-viewall, .dgc-hub-viewall, .dgc-hub-rest") || c).click();
    if (!document.querySelector(`#home-hub .hc-open .hc-card[data-card="${which}"]`)) throw new Error(`${which} did not open`); }, id);
    await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60))))); };
  /** Brings the hub card `key` into sight: Needs you opened for one that needs you, Recent opened for one that is new. */
  const see = async (key) => { const want = await page.evaluate((k) => { const c = [...document.querySelectorAll("#home-hub .dgc-hub-card")].find((n) => n.dataset.key === k); if (!c || c.checkVisibility()) return ""; return c.dataset.group === "new" ? "recent" : "needs"; }, key); if (want) await card(want); };
  /** `read()` gives a record for every hub card ([{ key, ... }], measured as drawn): read with Needs you opened for what
   *  needs you, and with Recent opened for what is new. Home is left as it was. */
  const everyCard = async (read) => { const [groups, was] = await page.evaluate(() => [Object.fromEntries([...document.querySelectorAll("#home-hub .dgc-hub-card")].map((c) => [c.dataset.key, c.dataset.group])), document.querySelector("#home-hub .hc-open .hc-card")?.dataset.card || ""]);
    const has = (g) => Object.values(groups).includes(g), out = [];
    if (has("needs")) { if (was !== "needs") await card("needs"); out.push(...(await read()).filter((c) => groups[c.key] !== "new")); }
    if (has("new")) { await card("recent"); out.push(...(await read()).filter((c) => groups[c.key] === "new")); }
    if (was && has("new")) await card(was);
    return out; };
  return { page, errors, send, posted, refresh, kept, card, see, everyCard, tabs: () => tabsNow(page), hub: () => hubNow(page), close: () => context.close() };
}

/** The tab bar as it is on screen: each tab's name, whether it is chosen, in the tab order, shown, its box and colour. */
export const tabsNow = (page) => page.evaluate(() => {
  const nav = document.getElementById("side-tabs"), rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  // (A tree from before the tabs has none: an empty bar, so a test says what is missing in its own words.)
  if (!nav) return { shown: false, role: "", tabs: [], panel: "", panelRole: "", panelLabelledBy: "", focus: "", header: !!document.getElementById("phead")?.checkVisibility(), width: innerWidth, overflowX: false, nav: null, bar: null };
  const bar = nav.querySelector(".dgc-tabs-bar");
  const tabs = [...nav.querySelectorAll('[role="tab"]')].map((t) => { const flip = t.querySelector(".dgc-tab-flip"), front = t.querySelector(".dgc-tab-front"), count = t.querySelector(".dgc-tab-count");
    return { id: t.dataset.tab, name: front?.textContent || "", selected: t.getAttribute("aria-selected") === "true", tab: t.tabIndex, shown: t.checkVisibility(), label: t.getAttribute("aria-label") || "",
      controls: t.getAttribute("aria-controls"), icons: [...t.querySelectorAll("svg, img, .codicon, .library-iris")].filter((n) => n.checkVisibility({ opacityProperty: true })).length,   // (the ones seen: each tab holds its icon for a narrow side bar)
      color: getComputedStyle(t).color, weight: getComputedStyle(front || t).fontWeight,
      // (front, frontOpacity: the name itself, which once turned over under the pointer; copies: how many times the name is in the tab.)
      glow: ((g) => g ? Number(getComputedStyle(g).opacity) : 0)(t.querySelector(".dgc-tab-glow")), ground: getComputedStyle(t).backgroundColor, front: front ? getComputedStyle(front).transform : "", copies: t.querySelectorAll(".dgc-tab-word").length,
      frontOpacity: front ? Number(getComputedStyle(front).opacity) : 1,
      count: count && !count.hidden ? count.textContent : "", countBox: count && !count.hidden ? rect(count) : null, clipped: rect(flip).left < rect(t).left - 0.5 || (count && !count.hidden ? rect(count) : rect(flip)).right > rect(t).right + 0.5, words: rect(flip), ...rect(t) }; });
  const panel = ["home-hub", "work-home", "chats-home", "library-home"].map((id) => document.getElementById(id)).find((n) => n?.checkVisibility()) || (document.getElementById("pips-host").checkVisibility() ? document.getElementById("pips-host") : null);
  return { shown: nav.checkVisibility(), role: bar.getAttribute("role"), nav: rect(nav), bar: rect(bar), tabs, panel: panel?.id || "", panelRole: panel?.getAttribute("role") || "", panelLabelledBy: panel?.getAttribute("aria-labelledby") || "",
    focus: document.activeElement?.dataset?.tab || document.activeElement?.id || "", header: !!document.getElementById("phead")?.checkVisibility(), width: innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth };
});

/** Home as it is on screen: the Show button, each group with its cards (source, who it is from, words, chips, answers, box), the notes and the empty line. */
export const hubNow = (page) => page.evaluate(() => {
  const hub = document.getElementById("home-hub"), rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  if (!hub) return { shown: false, show: null, groups: [], cards: [], notes: [], empty: null, menu: [], focus: "" };
  const show = hub.querySelector(".dgc-hub-show");
  const card = (c) => ({ key: c.dataset.key, source: c.dataset.source, group: c.dataset.group, from: c.querySelector(".dgc-card-sub")?.textContent || "", title: c.querySelector(".dgc-card-title").textContent,
    who: c.querySelector(".dgc-card-icon [data-mark]") ? `mark:${c.querySelector(".dgc-card-icon [data-mark]").dataset.mark}` : c.querySelector(".dgc-card-icon .dgc-sheet") ? `sheet:${c.querySelector(".dgc-card-icon .dgc-sheet").dataset.kind}`
      : c.querySelector(".dgc-card-icon svg, .dgc-card-icon .dgc-plush") ? "face" : "",
    // chips: what the card holds (the ones not folded into "+N"); shownChips: the ones on screen (a slim card shows them only on a free line)
    chips: [...c.querySelectorAll(".dgc-chip:not([hidden])")].map((x) => x.textContent), shownChips: [...c.querySelectorAll(".dgc-chip:not([hidden])")].filter((x) => x.checkVisibility()).map((x) => x.textContent), actions: [...c.querySelectorAll("[data-hub-act]")].map((b) => b.textContent + (b.matches(".primary, .dgc-ia-main") ? "*" : "")),   // (an icon button says its word too, and its main answer is .dgc-ia-main: media/shared/iconactions.js)
    line: c.querySelector(".dgc-card-note")?.textContent ?? "", held: c.classList.contains("dgc-hub-held"),
    thin: c.classList.contains("dgc-card-thin"), shared: c.classList.contains("dgc-card"), radius: getComputedStyle(c).borderRadius, ground: getComputedStyle(c).backgroundColor, ...rect(c) });
  return { shown: hub.checkVisibility(), show: show ? { value: show.querySelector(".dgc-hub-show-v").textContent, expanded: show.getAttribute("aria-expanded"), label: show.getAttribute("aria-label"), ...rect(show) } : null,
    // (What needs you first, then what is new, wherever each is drawn: Needs you's hub and Recent's are two elements.)
    groups: [...hub.querySelectorAll(".dgc-hub-group")].sort((a, b) => (a.dataset.group === "needs" ? 0 : 1) - (b.dataset.group === "needs" ? 0 : 1)).map((g) => ({ id: g.dataset.group, name: g.querySelector("h2").firstChild.textContent, count: g.querySelector(".dgc-hub-n").textContent,
      clear: !!g.querySelector(".dgc-hub-clear"), more: g.querySelector(".dgc-hub-more")?.textContent || "", rest: g.querySelector(".dgc-hub-rest")?.textContent || "", cards: [...g.querySelectorAll(".dgc-hub-card")].map(card) })),
    cards: [...hub.querySelectorAll(".dgc-hub-card")].sort((a, b) => (a.dataset.group === "needs" ? 0 : 1) - (b.dataset.group === "needs" ? 0 : 1)).map(card), notes: [...hub.querySelectorAll(".dgc-hub-note")].map((n) => n.textContent), empty: hub.querySelector(".dgc-hub-empty")?.textContent ?? null,
    menu: [...document.querySelectorAll(".dgc-hub-menu .dgc-menu-row")].map((r) => ({ name: r.querySelector(".dgc-menu-label").textContent, count: r.querySelector(".dgc-menu-hint")?.textContent || "", checked: r.getAttribute("aria-checked") === "true" })),
    focus: document.activeElement?.dataset?.hubAct ? `${document.activeElement.closest(".dgc-hub-card").dataset.key}/${document.activeElement.dataset.hubAct}` : document.activeElement?.dataset?.show ? `menu:${document.activeElement.dataset.show}` : document.activeElement?.className || "" };
});

/** Every word and mark on the tab's page (Home, Work or Chat, whichever shows), measured where it is drawn: its colour
    against the grounds under it, laid over one another the way the page paints them (a card's tint over the side bar, a
    row's hover wash). Returns [{what, text, ratio, color, ground}], words first, then marks (icons, a running row's dot,
    Show's chevron). (The tab bar's names stand on a gradient and a glow: the pictures' own tool measures those.) */
export const homeContrast = (page) => page.evaluate(() => {
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0];
    return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = [];
    for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (ink, e) => { const g = ground(e), c = over(parse(ink), g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p);
    return { ratio: Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100, color: c.slice(0, 3).map(Math.round).join(","), ground: g.slice(0, 3).map(Math.round).join(",") }; };
  const host = document.getElementById("sessions-host"), out = [];
  const name = (e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${e.classList.length ? "." + [...e.classList].join(".") : ""}`;
  const walk = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) {
    const e = t.parentElement;
    if (!t.textContent.trim() || !e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = e.getBoundingClientRect(); if (r.width < 2 || r.height < 2) continue;                          // kept for screen readers only
    const style = getComputedStyle(e), fill = style.webkitTextFillColor;
    out.push({ what: name(e), text: t.textContent.trim().slice(0, 40), kind: "words", ...ratio(fill && fill !== style.color ? fill : style.color, e) });
  }
  for (const e of host.querySelectorAll(".codicon, .session-live, .dgc-hub-chevron")) {
    if (!e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const dot = e.classList.contains("session-live"), style = getComputedStyle(e);
    out.push({ what: `${name(e.closest("button, li, h2, h3") || e)} ${name(e)}`, text: "", kind: "mark", ...ratio(dot ? style.backgroundColor : style.color, dot ? e.parentElement : e) });
  }
  const search = document.getElementById("sessions-search");
  if (search?.checkVisibility()) out.push({ what: "input#sessions-search placeholder", text: search.placeholder, kind: "words", ...ratio(getComputedStyle(search, "::placeholder").color, search) });
  return out;
});

/** `n` sessions, newest first, each `when` in the host's own "YYYY-MM-DD HH:MM" and told from now, so a row's age reads
    the same on any day: 2h, 1d, 3d, 1w, 2w, 1mo, 3mo, 1y, then a day older each. */
export function manySessions(n = 20, now = Date.now()) {
  const MIN = 60000, DAY = 1440 * MIN, pad = (v) => String(v).padStart(2, "0");
  const stamp = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
  const ages = [130 * MIN, DAY + 2 * 60 * MIN, 3 * DAY + 60 * MIN, 8 * DAY, 15 * DAY, 40 * DAY, 100 * DAY, 400 * DAY];
  const names = ["Run the shell command `ls -la src` and tell me in one line what is there", "Visits page alignment", "In one short sentence: what does nextWatering in src/app.js return?",
    "Invoice totals round the wrong way", "Dark mode for the settings page", "Why is the nightly export slow", "Rename the watering helpers", "First look at the garden project"];
  return Array.from({ length: n }, (_, k) => ({ id: `2026-s${pad(k)}`, path: `/s/s${pad(k)}.json`, name: k % 3 === 0 ? "" : names[k % names.length] + (k >= names.length ? ` (${k})` : ""),
    preview: names[k % names.length] + (k >= names.length ? ` (${k})` : ""), when: stamp(now - (ages[k] ?? (400 + k) * DAY)), count: 3 + k, open: k === 0 }));
}
