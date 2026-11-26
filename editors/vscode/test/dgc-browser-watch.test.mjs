// A Pip at work in DGC Browser is seen without hunting (Pips API 113, get_dgc_browser_lanes):
//   - while a Pip's run works in its tab there, the dock's DGC Browser tile says so ("Ava is working in it"), its halo
//     moves and the running dot is under it, as a busy tile's elsewhere in the dock;
//   - the dock hears of a Pip's new tab within seconds: it asks again every couple of seconds while any Pip's run is live,
//     every five seconds while none is, and at once when a Pip is asked to work from the side bar (never the minute-long
//     wait of Home's look at your links);
//   - in the Pip's chat, the working line of a run that is working in DGC Browser has Watch, which opens the same
//     streamed tab as the dock's "Watch Ava's tab";
//   - the editor's bridge lets get_dgc_browser_lanes through with no fields, never to an older DGC, and a Pip's chat
//     in its own tab may open only its own Pip's streamed tab.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, dockNow } from "./support/dock-scene.mjs";
import { homeState } from "./support/home-scene.mjs";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";
import { setup as onePips } from "./support/one-pips-node.mjs";
import { MORNINGS, makeBackend, openOnePips } from "./support/one-pips-scene.mjs";

let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
const skipReason = () => (!chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "");
const skipOrFail = (t) => {
  if (!skipReason()) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${skipReason()}`);
  t.skip(skipReason());
  return true;
};
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const AVA = "pip_" + "a".repeat(32), BEN = "pip_" + "b".repeat(32);
const waitFor = (page, fn, arg, timeout = 15000) => page.waitForFunction(fn, arg, { timeout });
const lane = (pip_id, name, working) => ({ pip_id, name, title: `${name} · Your cart`, url: "https://shop.example.com/cart", working });
const ready = (browserState = {}) => ({ ...homeState(), browser: { recent: { links: [], open: true, available: true, reason: "", lanes: [] }, lanes: [], runsLive: false, ...browserState } });
async function sideBar(state, api = 113) {
  const x = await openDock(browser, { width: 440, height: 720, theme: "dark-modern", api, state });
  await waitFor(x.page, () => !!document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]'));
  return x;
}
const tileNow = async (page) => {
  await page.mouse.move(2, 2);                        // (never pointed at, nor holding the keys: a halo moves then anyway)
  await page.evaluate(() => document.activeElement?.blur?.());
  await page.waitForTimeout(150);
  const item = (await dockNow(page)).items.find((i) => i.key === "browser");
  const halo = await page.evaluate(() => { const h = document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"] .halo i');
    return h ? getComputedStyle(h).animationPlayState : ""; });
  return { ...item, halo };
};
async function menu(x) {
  const tile = (await dockNow(x.page)).items.find((i) => i.key === "browser");
  await x.page.mouse.click(tile.left + tile.width / 2, tile.top + tile.height / 2, { button: "right" });
  await waitFor(x.page, () => document.querySelectorAll(".dgc-pop .dgc-menu-row").length > 0);
  const rows = (await dockNow(x.page)).menu;
  await x.page.keyboard.press("Escape");
  return rows;
}

test("while Ava's run works in her tab, the tile says so, its halo moves and the running dot is under it", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(ready({ lanes: [lane(AVA, "Ava", true)], runsLive: true }));
  try {
    await waitFor(x.page, () => /Ava is working in it/.test(document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]')?.getAttribute("aria-label") || ""));
    const tile = await tileNow(x.page);
    assert.match(tile.label, /^DGC Browser\. Ava is working in it/);
    assert.equal(tile.dot, "live", "the running dot, as a busy session's tile");
    assert.equal(tile.halo, "running", "its halo moves while she works");
    assert.ok((await menu(x)).includes("Watch Ava's tab"));
    // Two at work: both named; then her run ends and the tile is still again.
    await x.page.evaluate(([a, b]) => { window.__state.browser.lanes = [a, b]; }, [lane(AVA, "Ava", true), lane(BEN, "Ben", true)]);
    await waitFor(x.page, () => /Ava and Ben are working in it/.test(document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]')?.getAttribute("aria-label") || ""), null, 8000);
    await x.page.evaluate(([a]) => { window.__state.browser.lanes = [a]; window.__state.browser.runsLive = false; }, [lane(AVA, "Ava", false)]);
    await waitFor(x.page, () => !/working in it/.test(document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]')?.getAttribute("aria-label") || ""), null, 8000);
    const still = await tileNow(x.page);
    assert.notEqual(still.dot, "live");
    assert.equal(still.halo, "paused", "still again, until it is pointed at");
    assert.ok((await menu(x)).includes("Watch Ava's tab"), "her tab is still there to watch until it closes");
  } finally { await x.close(); }
});

test("the dock hears of a Pip's new tab within seconds while a run is live, and asks every five seconds while none is", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(ready({ runsLive: true }));
  try {
    await waitFor(x.page, () => window.__answered.includes("get_dgc_browser_lanes"));
    assert.deepEqual(await menu(x), ["Open DGC Browser", "Sites Pips can use…", "Clear browsing data…"]);
    const at = Date.now();
    await x.page.evaluate((l) => { window.__state.browser.lanes = [l]; }, lane(AVA, "Ava", true));
    await waitFor(x.page, () => /Ava is working in it/.test(document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]')?.getAttribute("aria-label") || ""), null, 8000);
    assert.ok(Date.now() - at < 5000, `heard within seconds (${Date.now() - at} ms), not at the next minute's look`);
    assert.ok((await menu(x)).includes("Watch Ava's tab"));
    // While a run is live it asks every couple of seconds; with nothing live and no tab, every five.
    const count = () => x.page.evaluate(() => window.__requests.filter((r) => r.type === "get_dgc_browser_lanes").length);
    let before = await count();
    await x.page.waitForTimeout(10000);
    const live = await count() - before;
    assert.ok(live >= 3, `every couple of seconds while a run is live (${live} in 10 s; five on an idle machine)`);
    await x.page.evaluate(() => { window.__state.browser.lanes = []; window.__state.browser.runsLive = false; });
    await x.page.waitForTimeout(3000);
    before = await count();
    await x.page.waitForTimeout(10000);
    const idle = await count() - before;
    assert.ok(idle >= 1 && idle <= 2, `every five seconds with nothing live (${idle} in 10 s)`);
    const shapes = await x.page.evaluate(() => window.__requests.filter((r) => r.type === "get_dgc_browser_lanes").map((r) => Object.keys(r).sort().join()));
    assert.deepEqual([...new Set(shapes)], ["type"],
      "it asks with no fields");
  } finally { await x.close(); }
});

test("an older DGC is never asked for the Pips' tabs", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(ready({ lanes: [lane(AVA, "Ava", true)], runsLive: true }), 112);
  try {
    await waitFor(x.page, () => window.__answered.includes("get_dgc_browser_recent"));
    await x.page.waitForTimeout(3000);
    assert.equal(await x.page.evaluate(() => window.__requests.filter((r) => r.type === "get_dgc_browser_lanes").length), 0);
  } finally { await x.close(); }
});

// ---- the editor's bridge ------------------------------------------------------------------------------------------------
const viewModule = await pipsViewModule();
const vscodeStub = { ViewColumn: { Active: -1, Beside: -2 }, Uri: { joinPath: (...p) => ({ path: p.map((x) => x.path || x).join("/") }), file: (p) => ({ path: p }) },
  workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (k, f) => f }) }, window: { state: { focused: true }, onDidChangeWindowState: () => ({ dispose() {} }) } };
function bridge(api) {
  const { PipsEditor } = viewModule(vscodeStub);
  const page = [], sent = [];
  const editor = new PipsEditor({ path: "ext" }, (m) => { sent.push(m); return true; }, () => {}, true);
  editor.attach((m) => page.push(m));
  editor.ready({ pips_supported: true, pips_enabled: true, pips_api_version: api }, {});
  editor.receive({ type: "pipsReady" });
  const generation = page.filter((m) => m.type === "pipsConnection").at(-1).generation;
  return { editor, ask: (id, request) => editor.receive({ type: "pipsRequest", id, generation, request }), controls: () => sent.filter((m) => m.type === "pips_control").map((m) => m.request), replies: () => page.filter((m) => m.type === "pipsReply") };
}

test("the bridge lets the dock's look at the Pips' tabs through with no fields, never to an older DGC", () => {
  const b = bridge(113);
  b.ask("r1", { type: "get_dgc_browser_lanes" });
  b.ask("r2", { type: "get_dgc_browser_lanes", pip_id: AVA });
  assert.deepEqual(b.controls().map((r) => r.type), ["get_dgc_browser_lanes"]);
  assert.deepEqual(b.replies().map((m) => m.error?.message), ["DGC Browser can't be asked that from here."]);
  const older = bridge(112);
  older.ask("r1", { type: "get_dgc_browser_lanes" });
  assert.deepEqual(older.controls(), []);
  assert.match(older.replies()[0].error.message, /Update DGC/);
});

// A Work session's own tab in DGC Browser (26 Nov: Work sessions use it too): the dock lists it to watch, by its name
// ("Work · lime_tiles"), and opens it in an editor tab; a Pip's chat page never opens it.
test("a Work session's tab: the dock's Watch lists it by name and opens it; a Pip's chat page can't", async (t) => {
  if (skipOrFail(t)) return;
  const WORK = "work:" + "a".repeat(32);
  const x = await sideBar(ready({ lanes: [{ pip_id: WORK, name: "Work · lime_tiles", title: "Example Domain", url: "https://example.com/", working: true }], runsLive: true }));
  try {
    await waitFor(x.page, () => /Work · lime_tiles is working in it/.test(document.querySelector('#dgc-dock .dgc-dock-item[data-key="browser"]')?.getAttribute("aria-label") || ""));
    assert.ok((await menu(x)).includes("Watch Work · lime_tiles"), "named, never \"Work · lime_tiles's tab\"");
  } finally { await x.close(); }
  const b = bridge(113), opened = [];
  b.editor.openDgcBrowserTab = (lane) => opened.push(lane);
  b.editor.chats.set("ava", { panel: {}, pip: { id: AVA, name: "Ava", pip_type: "lens" }, conversation: "" });
  b.editor.receive({ type: "pipsOpenDgcBrowser", pip: { id: WORK, name: "Work · lime_tiles" } }, "main");
  b.editor.receive({ type: "pipsOpenDgcBrowser", pip: { id: WORK, name: "Work · lime_tiles" } }, "chat:ava");
  b.editor.receive({ type: "pipsOpenDgcBrowser", pip: { id: "work:../x", name: "Work" } }, "main");
  assert.deepEqual(opened, [{ id: WORK, name: "Work · lime_tiles" }], "from the dock only, and only a well-formed name");
});

test("a Pip's chat in its own tab opens only its own Pip's streamed tab (its working line's Watch)", () => {
  const b = bridge(113), opened = [];
  b.editor.openDgcBrowserTab = (pip) => opened.push(pip);
  const chats = b.editor.chats;
  chats.set("ava", { panel: {}, pip: { id: AVA, name: "Ava", pip_type: "lens" }, conversation: "" });
  b.editor.receive({ type: "pipsOpenDgcBrowser", pip: { id: AVA, name: "Ava" } }, "chat:ava");
  b.editor.receive({ type: "pipsOpenDgcBrowser", pip: { id: BEN, name: "Ben" } }, "chat:ava");
  b.editor.receive({ type: "pipsOpenDgcBrowser", pip: { id: AVA, name: "Someone else" } }, "chat:ava");
  b.editor.receive({ type: "pipsOpenDgcBrowser", pip: { id: BEN, name: "Ben" } }, "main");
  assert.deepEqual(opened, [{ id: AVA, name: "Ava" }, { id: AVA, name: "Ava" }, { id: BEN, name: "Ben" }],
    "its own Pip only, under the name the tab knows; the Pips page (the dock's own) any Pip");
});

// ---- the Pip's chat: Watch on the working line ---------------------------------------------------------------------------
// (The Pips view as the side bar mounts it, on the One Pips stand-in: Mornings is a Personal Pip with a computer.)
const RUN = "run_" + "9".repeat(32), PERSONAL = "ws_" + "1".repeat(32);
const opened = [];
after(() => opened.forEach((w) => w.close()));
async function openChat({ api = 113, lanes = [lane(MORNINGS, "Mornings", true)], active = { id: RUN, status: "running", started_at: new Date().toISOString(), created_at: new Date().toISOString() } } = {}) {
  const page = { messages: active ? [{ id: "msg_" + "7".repeat(32), pip_id: MORNINGS, workspace_id: PERSONAL, role: "user", text: "Find the cheapest one", run_id: RUN, model: "m", status: "running", created_at: new Date().toISOString() }] : [] };
  const x = onePips({ api, scene: { mine: true, answers: { get_dgc_browser_lanes: { lanes, runs_live: true } } } });
  opened.push(x.w);
  // (Mornings's chat as the stand-in has it, with a run of it live.)
  const own = x.backend.answer.bind(x.backend);
  x.backend.answer = (r) => { const said = own(r); return r.type === "list_pip_messages" && r.pip_id === MORNINGS && said && !said.error ? { ...said, messages: [...said.messages, ...page.messages], active_run: active } : said; };
  await x.drain();
  await x.openPip(MORNINGS);
  return x;
}

test("in its chat, the working line of a run in DGC Browser has Watch, which opens its streamed tab", async () => {
  const x = await openChat();
  assert.ok(x.requests("get_dgc_browser_lanes").length >= 1, "it asks which Pips work there while its run is live");
  assert.deepEqual(Object.keys(x.requests("get_dgc_browser_lanes")[0]), ["type"]);
  const line = x.$(".pip-working");
  assert.ok(line, "the working line");
  const watch = line.querySelector("[data-yb-watch]");
  assert.ok(watch, "Watch on it");
  assert.equal(watch.textContent.trim(), "Watch");
  assert.equal(watch.getAttribute("aria-label"), "Watch Mornings’s tab in DGC Browser");
  watch.click();
  assert.deepEqual(x.posted("pipsOpenDgcBrowser").map((m) => m.pip), [{ id: MORNINGS, name: "Mornings" }]);
});

test("no Watch while its run isn't working in DGC Browser, for another Pip's work, nor with an older DGC", async () => {
  const idle = await openChat({ lanes: [lane(MORNINGS, "Mornings", false)] });
  assert.ok(idle.$(".pip-working"));
  assert.equal(idle.$("[data-yb-watch]"), null, "its tab idles: nothing to watch it do");
  const other = await openChat({ lanes: [lane("pip_" + "f".repeat(32), "Fern", true)] });
  assert.equal(other.$("[data-yb-watch]"), null, "another Pip's work is the dock's, not this chat's");
  const done = await openChat({ active: null });
  assert.equal(done.$("[data-yb-watch]"), null, "no run live: nothing asked, nothing to watch");
  assert.equal(done.requests("get_dgc_browser_lanes").length, 0);
  const older = await openChat({ api: 112 });
  assert.equal(older.requests("get_dgc_browser_lanes").length, 0, "an older DGC is never asked");
  assert.equal(older.$("[data-yb-watch]"), null);
});

// ---- Watch's size: a small button sized to its word, beside or under the line's words, never a bar -------------------
// (Real Chromium, the Pips view as the side bar mounts it: Mornings with a reply at work, and with a Run now's live post.)
const RUN2 = "run_" + "8".repeat(32);
function liveScene(kind) {
  const now = new Date().toISOString(), base = makeBackend({ mine: true });
  const lanes = { lanes: [{ pip_id: MORNINGS, name: "Mornings", title: "Mornings · Soumission", url: "https://books.toscrape.com/", working: true }], runs_live: true };
  if (kind === "reply") {
    const page = base.answer({ type: "list_pip_messages", pip_id: MORNINGS });
    return { mine: true, answers: { get_dgc_browser_lanes: lanes, list_pip_messages: { byPip: { [MORNINGS]: { ...page,
      messages: [...page.messages, { id: "msg_" + "7".repeat(32), pip_id: MORNINGS, workspace_id: page.workspace_id, role: "user", text: "What does Soumission cost?", run_id: RUN2, model: "m", status: "running", created_at: now }],
      active_run: { id: RUN2, status: "running", started_at: now, created_at: now } } } } } };
  }
  const pip = base.answer({ type: "get_pip", pip_id: MORNINGS }).pip;
  return { mine: true, answers: { get_dgc_browser_lanes: lanes, get_pip: { byPip: { [MORNINGS]: { pip: { ...pip, active_run: { id: RUN2, status: "running", run_kind: "personal_task", started_at: now, created_at: now } } } } } } };
}
for (const kind of ["reply", "post"]) {
  for (const [width, theme] of [[300, "dark-modern"], [440, "dark-modern"], [300, "light-modern"], [440, "light-modern"]]) {
    test(`Watch on ${kind === "reply" ? "the working line" : "a live post"} at ${width} px, ${theme}: the small button, sized to its word`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await openOnePips(browser, { width, height: 760, theme, api: 113, scene: liveScene(kind) });
      try {
        await x.page.waitForFunction((id) => !!document.getElementById("pips-host")?.shadowRoot?.querySelector(`[data-job="${id}"]`), MORNINGS, { timeout: 15000 });
        await x.page.evaluate((id) => document.getElementById("pips-host").shadowRoot.querySelector(`[data-job="${id}"]`).click(), MORNINGS);
        await x.page.waitForFunction(() => !!document.getElementById("pips-host").shadowRoot.querySelector("[data-yb-watch]"), null, { timeout: 15000 });
        const got = await x.page.evaluate(() => {
          const b = document.getElementById("pips-host").shadowRoot.querySelector("[data-yb-watch]"), r = b.getBoundingClientRect();
          const line = b.closest(".pip-working, .run-post-attach").getBoundingClientRect(), cs = getComputedStyle(b);
          const words = document.createRange(); words.selectNodeContents(b); const w = words.getBoundingClientRect().width;
          return { width: r.width, height: r.height, words: w, pad: parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) + parseFloat(cs.borderLeftWidth) + parseFloat(cs.borderRightWidth),
            radius: cs.borderTopLeftRadius, lineWidth: line.width, text: b.textContent.trim(), dgc: b.classList.contains("dgc-btn") };
        });
        assert.equal(got.text, "Watch");
        assert.ok(got.dgc, "the shared button (.dgc-btn)");
        assert.equal(got.radius, "6px", "the one control corner");
        assert.equal(Math.round(got.height), 22, `the small button height (${got.height})`);
        assert.ok(Math.abs(got.width - (got.words + got.pad)) <= 2, `as wide as its word and its padding (${got.width} for ${got.words} + ${got.pad})`);
        assert.ok(got.width < got.lineWidth / 2, `never a bar across the line (${got.width} of ${got.lineWidth})`);
      } finally { await x.close(); }
    });
  }
}
