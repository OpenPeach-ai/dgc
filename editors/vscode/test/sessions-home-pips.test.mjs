// Your Pips on the side bar's Home, in real Chromium with the real Pips bundle and faces. A user:
// a Pips notice above a coding session's composer "has nothing to do with that session"; the side
// bar's Home shows the Pips that need you and the ones with news, each as a card, and session tabs show none.
// (Before the tabs these were rows in a block above the sessions; side-tabs-home.test.mjs holds the tabs and the hub.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const bundled = await build({ entryPoints: [fileURLToPath(new URL("../src/pipsClient.js", import.meta.url))], bundle: true, write: false,
  format: "iife", outdir: "dist", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
const pipsJs = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const pipsCss = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const sprite = readFileSync(new URL("../media/pips/plush-bodies.webp", import.meta.url));
const P = "ws_" + "1".repeat(32), Q = "ws_" + "2".repeat(32);
const pip = (id, name, type, waiting = 0, status = "active") => ({ id: "pip_" + id.repeat(32), name, pip_type: type, workspace_id: P, status,
  pending_review_count: waiting, version: 1 });
const DIGEST = (pips) => ({ schema_version: 1, since: "2026-10-06T00:00:00.000Z", until: "2026-10-06T12:00:00.000Z", first: false, due: false, reason: null,
  headline: "Your Pips", pips, omitted_pips: 0, failed_runs: 0, pending_reviews: 0, pending_setups: 0, truncated: false });
const digestPip = (id, name, type, extra = {}) => ({ pip_id: "pip_" + id.repeat(32), workspace_id: P, name, pip_type: type, scope: "personal", status: "active",
  min_severity: "low", alert_severity: null, runs: { succeeded: 1, failed: 0, cancelled: 0 }, skipped_unchanged: 0, new_total: 0, below_threshold: 0,
  new_findings: [], gone_after_change: 0, alert: false, latest_run_id: null, ...extra });

async function openHome({ pips, digestPips = [], place = "home", width = 380, height = 640, api = 43, waiting = null, chats = false, opened = "needs" }) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await (await browser.newContext({ viewport: { width, height } })).newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  const doc = html.replace("</head>", `<style>${pipsCss}</style></head>`).replace("</body>", `<script src="/ext/dist/pips.js"></script></body>`);
  await page.route("https://home.test/**", (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/ext/dist/pips.js") return r.fulfill({ body: pipsJs, contentType: "text/javascript" });
    if (path === "/ext/media/pips/plush-bodies.webp") return r.fulfill({ body: sprite, contentType: "image/webp" });
    return r.fulfill({ body: doc, contentType: "text/html" });
  });
  await page.goto("https://home.test/webview/index.html");
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
  await page.evaluate(() => document.body.classList.add("vscode-dark"));
  await page.evaluate(([mjs, mdjs, where, list, digest, apiVersion, attention, tabs, opened]) => {
    document.documentElement.dataset.chatPlace = where;
    document.documentElement.dataset.pipsDocumentId = "doc1";
    if (tabs) document.documentElement.dataset.chatdgcSeen = "1";   // ChatDGC: the Chat | Work tabs under the Pips
    window.__posted = [];
    const answers = { list_workspaces: () => ({ workspaces: [{ id: "ws_" + "1".repeat(32), name: "Your Pips", kind: "personal" }, { id: "ws_" + "2".repeat(32), name: "demo", kind: "project" }],
      current_workspace_id: "ws_" + "2".repeat(32) }),
      list_pips: (r) => ({ pips: r.workspace_id === "ws_" + "1".repeat(32) ? list : [] }), get_pip_digest: () => ({ digest }), list_pip_attention: () => attention,
      mark_pip_news_seen: (r) => ({ seen: r.pip_ids.map((pip_id) => ({ pip_id, seen_until: r.until })) }) };
    window.acquireVsCodeApi = () => ({ getState: () => ({ homeCards: { open: opened } }) /* Home opens with one card opened whole, its hub cards as a list: Needs you, or (opened: "recent") Recent, where what is new is */, setState() {}, postMessage(m) {
      window.__posted.push(m);
      const make = m?.type === "pipsRequest" && answers[m.request.type];
      if (make) setTimeout(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsReply", id: m.id, ok: true, result: make(m.request) } })), 2);
    } });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
    window.dispatchEvent(new MessageEvent("message", { data: { type: "pipsConnection", generation: 1, apiVersion, connected: true, supported: true, enabled: true } }));
  }, [mainJs, markdownJs, place, pips, DIGEST(digestPips), api, waiting, chats, opened]);
  return { page, errors };
}

/** Home's cards as they are on screen. */
const cards = (page) => page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-hub-card")].map((c) => ({ key: c.dataset.key, group: c.dataset.group, from: c.querySelector(".dgc-card-sub").textContent,
  title: c.querySelector(".dgc-card-title").textContent, chips: [...c.querySelectorAll(".dgc-chip:not([hidden])")].map((x) => x.textContent), answers: [...c.querySelectorAll("[data-hub-act]")].map((b) => b.textContent),   // (icons since 12 Nov, each still named by its word)
  character: c.querySelector(".dgc-plush")?.dataset.character || "", state: c.querySelector(".dgc-plush")?.dataset.state || "" })));
const polled = (page) => page.waitForFunction(() => window.__posted.some((m) => m.type === "pipsRequest" && m.request.type === "get_pip_digest") && !!document.querySelector("#home-hub .hc-cards-btn"));

test("the Pips that need you and the ones with news are cards on Home, each with its face and what it wants", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openHome({
    pips: [pip("b", "India Market Brief", "quill", 2), pip("a", "Core", "core"), pip("c", "Gmail", "scout"), pip("d", "Old", "lens", 3, "archived")],
    digestPips: [digestPip("a", "Core", "core", { new_total: 3 })] });
  try {
    await page.waitForSelector("#home-hub .dgc-hub-card");
    const m = await cards(page);
    assert.deepEqual(m.map((c) => [c.from, c.title, c.group, c.character, c.state]), [["India Market Brief · Pip", "2 things are waiting for you", "needs", "quill", "waiting_approval"],
      ["Core · Pip", "3 new findings", "new", "core", "success"]],
      "what waits for you first (reported 2026-10-18); only the Pips that need you or have news; an archived Pip never; Gmail has nothing and has no card");
    assert.deepEqual(m.map((c) => c.answers), [["Review"], ["Open"]], "an older DGC keeps no dismiss: one answer each");
    const loaded = await page.evaluate(() => [...document.querySelectorAll("#home-hub .dgc-plush-rig > image:first-child")].every((i) => new URL(i.getAttribute("href"), document.baseURI).pathname === "/ext/media/pips/plush-bodies.webp"));
    assert.equal(loaded, true, "the real faces");
    assert.equal(await page.evaluate(() => document.getElementById("side-tab-home-count").textContent), "2", "Home's number: the two things that Pip waits on you for");
    assert.equal(await page.getAttribute("#side-tab-home", "aria-label"), "Home: 2 need you, 1 new", "the one with news is in its words");
    await page.click('#home-hub .dgc-hub-card:has-text("India Market Brief") [data-hub-act="open"]');
    await page.waitForFunction(() => !document.getElementById("pips-host").hidden);
    assert.equal(await page.evaluate(() => document.getElementById("sessions-host").hidden), true, "the Pips view opens in Home's place");
    assert.equal(await page.evaluate(() => document.getElementById("side-tab-pips").getAttribute("aria-selected")), "true", "and the Pips tab is the one lit");
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

test("when nothing is waiting, Home says so in one line; your Pips are on their tab", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openHome({ pips: [pip("a", "Core", "core"), pip("c", "Gmail", "scout")] });
  try {
    await polled(page);
    await page.waitForSelector("#home-hub .dgc-hub-empty");
    assert.equal(await page.locator("#work-apps").count(), 0, "Apps stays out of Work while the experiment is on hold");
    const m = await page.evaluate(() => ({ text: document.querySelector("#home-hub .dgc-hub-empty").textContent, cards: document.querySelectorAll("#home-hub .dgc-hub-card").length,
      count: document.getElementById("side-tab-home-count").hidden, pips: document.getElementById("side-tab-pips").checkVisibility() }));
    assert.deepEqual(m, { text: "Nothing needs you.", cards: 0, count: true, pips: true });
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

test("with no Pips Home has no Pip's card, and a session's tab shows neither the Pips bell nor the side bar's tabs", async (t) => {
  if (skipOrFail(t)) return;
  const home = await openHome({ pips: [] });
  try {
    await polled(home.page);
    assert.deepEqual(await cards(home.page), []);
  } finally { await home.page.context().close(); }
  const tab = await openHome({ pips: [pip("b", "India Market Brief", "quill", 2)], place: "tab", width: 900 });
  try {
    await tab.page.waitForTimeout(400);
    const m = await tab.page.evaluate(() => ({ bar: !document.getElementById("pipsbar").hidden, tabs: document.getElementById("side-tabs").checkVisibility(), hub: document.getElementById("home-hub").checkVisibility(),
      digest: window.__posted.some((x) => x.type === "pipsRequest" && x.request.type === "get_pip_digest") }));
    assert.deepEqual(m, { bar: false, tabs: false, hub: false, digest: false }, "no bell, no tab bar, no Home and no digest polling in a session's tab");
  } finally { await tab.page.context().close(); }
});

// Needs attention (#8): what a Pip's chat waits on (a Connect card, an email to Send) is a card here too, so an
// empty Home means nothing waits; Review opens that Pip at its newest card.
test("a card waiting in a Pip's chat is a card on Home in its own words, and Review opens the Pip at it", async (t) => {
  if (skipOrFail(t)) return;
  const gmail = "pip_" + "c".repeat(32), card = "applink_" + "1".repeat(32);
  const item = { id: "app_link:" + card, kind: "app_link", card, pip_id: gmail, pip_name: "Gmail", pip_type: "scout", workspace_id: P,
    created_at: new Date().toISOString(), expires_at: null, title: "Connect Gmail?", detail: "To read your new mail." };
  const { page, errors } = await openHome({ pips: [pip("a", "Core", "core"), pip("c", "Gmail", "scout")], api: 44,
    waiting: { as_of: new Date().toISOString(), total: 1, counts: { app_link: 1 }, by_pip: { [gmail]: 1 }, items: [item], truncated: false } });
  try {
    await page.waitForSelector("#home-hub .dgc-hub-card");
    const m = await cards(page);
    assert.deepEqual(m.map((c) => [c.from, c.title, c.chips, c.answers]), [["Gmail · Pip · now", "Connect Gmail?", ["App", "To read your new mail."], ["Review"]]], "not empty: Gmail's chat has a card for you");
    await page.click('#home-hub [data-hub-act="open"]');
    await page.waitForFunction(() => !document.getElementById("pips-host").hidden);
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

// Reported 2026-10-18: "my 3 Pips ran and failed ... there should be a dismiss option there too" and
// "what if there were 100 Pips". A news card has Dismiss beside Open; Home shows eight of a group and a line for the rest.
const longId = (n) => "pip_" + n.toString(16).padStart(32, "0");
const listed = (n, name, waiting = 0) => ({ id: longId(n), name, pip_type: n === 0 ? "core" : "scout", workspace_id: P, status: "active", pending_review_count: waiting, version: 1 });
const failedRun = (n, name) => ({ pip_id: longId(n), workspace_id: P, name, pip_type: n === 0 ? "core" : "scout", scope: "personal", status: "active",
  min_severity: "low", alert_severity: null, runs: { succeeded: 0, failed: 1, cancelled: 0 }, skipped_unchanged: 0, new_total: 0, below_threshold: 0,
  new_findings: [], gone_after_change: 0, alert: false, latest_run_id: null });
// 100 Pips; 37 need you: 17 wait for an answer, 20 have a failed run (the digest names 20 at most).
const hundred = Array.from({ length: 100 }, (_, n) => listed(n, n === 0 ? "Core" : `Pip ${n}`, n % 6 === 1 ? 1 : 0));
const HUNDRED = { pips: hundred, digestPips: hundred.filter((p, n) => n && !p.pending_review_count).slice(0, 20).map((p) => failedRun(parseInt(p.id.slice(4), 16), p.name)) };

test("a failed run's Dismiss is always in sight, sits clear of the name at 300px, and dismisses from the keyboard", async (t) => {
  if (skipOrFail(t)) return;
  const name = "ERP daily audit — data & Tally integrity, every unit";
  const { page, errors } = await openHome({ opened: "recent", pips: [listed(1, name), listed(2, "GST watchdog — e-invoice & e-way")], width: 300, api: 48,
    digestPips: [failedRun(1, name), failedRun(2, "GST watchdog — e-invoice & e-way")] });
  try {
    await page.waitForSelector('#home-hub [data-hub-act="dismiss"]');
    const box = await page.evaluate(() => {
      const card = document.querySelector("#home-hub .dgc-hub-card"), x = card.querySelector('[data-hub-act="dismiss"]'), from = card.querySelector(".dgc-card-sub"), title = card.querySelector(".dgc-card-title");
      const r = (e) => { const b = e.getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom }; };
      return { x: r(x), from: r(from), title: r(title), card: r(card), clipped: from.scrollWidth > from.clientWidth, seen: x.checkVisibility({ visibilityProperty: true, opacityProperty: true }), word: x.textContent, hint: document.getElementById(x.getAttribute("aria-describedby"))?.textContent || "", tip: x.title };
    });
    assert.deepEqual([box.seen, box.word], [true, "Dismiss"], "in sight without pointing at anything, and named in a word");
    // (An icon since 12 Nov: pointing at it shows the word as a pill; the longer line is its description, not a tooltip.)
    assert.match(box.hint, /^Dismiss: 1 run failed\. It comes back if ERP daily audit/, "its description says what it dismisses");
    assert.equal(box.tip, "", "no tooltip beside the pill");
    assert.ok(box.title.right <= box.x.left && box.from.right <= box.x.left, `(a slim card: Dismiss is beside the words, at the right) Dismiss never covers the name or the sentence: ${JSON.stringify(box)}`);
    assert.ok(box.x.right <= box.card.right && box.card.right <= 300 && box.x.bottom <= box.card.bottom, "inside its card, inside the side bar");
    assert.equal(box.clipped, true, "a long name is cut with an ellipsis, on its one line");
    await page.focus('#home-hub .dgc-hub-card >> nth=0 >> [data-hub-act="open"]');
    await page.keyboard.press("Tab");
    assert.equal(await page.evaluate(() => `${document.activeElement.closest(".dgc-hub-card").dataset.key} ${document.activeElement.dataset.hubAct}`), `pip:${longId(1)} dismiss`, "Tab reaches it");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => document.querySelectorAll("#home-hub .dgc-hub-card").length === 1);
    const sent = await page.evaluate(() => window.__posted.filter((m) => m.type === "pipsRequest" && m.request.type === "mark_pip_news_seen").map((m) => m.request.pip_ids));
    assert.deepEqual(sent, [[longId(1)]]);
    assert.equal(await page.evaluate(() => `${document.activeElement.closest(".dgc-hub-card")?.dataset.key} ${document.activeElement.dataset.hubAct}`), `pip:${longId(2)} dismiss`, "focus moves to the next card's Dismiss");
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});

test("100 Pips, 17 waiting and 20 with news: eight cards of each and a line for the rest, counted in full, at 460×700", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors } = await openHome({ ...HUNDRED, width: 460, height: 700, api: 48, chats: true });
  try {
    await page.waitForSelector("#home-hub .dgc-hub-rest");
    const m = await page.evaluate(() => {
      const group = (id) => { const g = document.querySelector(`#home-hub .dgc-hub-group[data-group="${id}"]`); return { count: g.querySelector(".dgc-hub-n").textContent, cards: g.querySelectorAll(".dgc-hub-card").length, rest: g.querySelector(".dgc-hub-rest")?.textContent || "",
        titles: [...new Set([...g.querySelectorAll(".dgc-card-title")].map((x) => x.textContent))] }; };
      const tabs = document.getElementById("side-tabs").getBoundingClientRect();
      return { needs: group("needs"), fresh: group("new"), home: document.getElementById("side-tab-home-count").textContent, heard: document.getElementById("side-tab-home").getAttribute("aria-label"), tabsBottom: Math.round(tabs.bottom), all: document.querySelectorAll("#home-hub .dgc-hub-card").length };
    });
    assert.deepEqual(m.needs, { count: "17", cards: 8, rest: "Show 9 more", titles: ["1 thing is waiting for you"] }, "what waits for you first: eight cards, and the rest a click away");
    assert.deepEqual(m.fresh, { count: "20", cards: 8, rest: "Show 12 more", titles: ["1 run failed"] }, "then the 20 with news, the same way");
    assert.equal(m.home, "17", "Home's number counts every one that waits");
    assert.equal(m.heard, "Home: 17 need you, 20 new", "and its words count every one with news");
    // Before the cap a list of all 37 was two screens long before anything else: sixteen cards at most until you ask.
    assert.equal(m.all, 16);
    assert.ok(m.tabsBottom <= 84, `the tabs stay at the top, under the header row: ${m.tabsBottom}px`);
    await page.click('#home-hub .dgc-hub-group[data-group="needs"] .dgc-hub-rest');
    assert.equal(await page.evaluate(() => document.querySelectorAll('#home-hub .dgc-hub-group[data-group="needs"] .dgc-hub-card').length), 17, "Show 9 more: all seventeen");
    assert.equal(await page.evaluate(() => `${document.activeElement.closest(".dgc-hub-card")?.dataset.key}`), `pip:${longId(49)}`, "and the keyboard is on the first of the nine");
    await page.click("#side-tab-pips");
    await page.waitForFunction(() => !document.getElementById("pips-host").hidden);
    assert.deepEqual(errors, []);
  } finally { await page.context().close(); }
});
