// Sites Pips can use (Pips API 113): the one panel of every site the person is signed in to in Your Browser, and which
// Pips may use each (media/shared/ybsites.js, real Chromium on the real side bar):
//   - the dock's Your Browser menu offers "Sites Pips can use…", with "(2 new)" for sites noticed from the person's own
//     sign-ins since they last looked; an older DGC is offered nothing;
//   - the panel lists every site (the new ones first, marked New; a bank or payment site marked so), each with All Pips
//     / Some Pips (tick which) / No Pips and Sign out (asked once more in its row); a change is asked of DGC at once, one
//     site at a time, and a refusal is said in that site's row; opening it is looking (seen_your_browser_sites);
//   - one design language at 300, 440 and 700 px in both themes, and on one solid ground where a theme's raised grey is
//     see-through (Cursor's dark themes: input background #ffffff0d);
//   - a Pip's page: its own sites (Remove; an All Pips site asks first), the others (Let it use), All sites… (the same
//     panel); a grant its chat's card made is one of its sites, removable there;
//   - the editor's bridge lets the four commands through with their fields only, never to an older DGC, and tells a page
//     nothing of the person's own tabs.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openDock, dockNow } from "./support/dock-scene.mjs";
import { homeState } from "./support/home-scene.mjs";
import { pipsViewModule } from "./support/pip-chat-scene.mjs";
import { setup as onePips } from "./support/one-pips-node.mjs";
import { MORNINGS } from "./support/one-pips-scene.mjs";

const PICTURES = process.env.DGC_YB_PICTURES || "";
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
const PIPS = [{ pip_id: AVA, name: "Ava" }, { pip_id: BEN, name: "Ben" }];
const SITES = () => [
  { site: "lanestore.com", shown: "lanestore.com", mode: "chosen", money: false, pips: [{ pip_id: AVA, name: "Ava" }], new: false, sso_hosts: [], added_by: "you" },
  { site: "github.com", shown: "github.com", mode: "all", money: false, pips: [], new: true, sso_hosts: [], added_by: "noticed" },
  { site: "northwind-bank.com", shown: "northwind-bank.com", mode: "chosen", money: true, pips: [], new: true, sso_hosts: [], added_by: "noticed" },
];
const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 15000 });
const requests = (page, type) => page.evaluate((t) => window.__requests.filter((r) => r.type === t), type);
const ready = (extra = {}) => ({ ...homeState(), browser: { recent: { links: [], open: true, available: true, reason: "", lanes: [], new_sites: 2 }, sites: SITES(), pips: PIPS, lanes: [], runsLive: false, ...extra } });
async function sideBar(width = 440, theme = "dark-modern", state = ready(), api = 113) {
  const x = await openDock(browser, { width, height: 760, theme, api, state });
  await waitFor(x.page, () => window.__answered.includes("get_your_browser_recent"));
  return x;
}
async function menu(x) {
  const tile = (await dockNow(x.page)).items.find((i) => i.key === "browser");
  await x.page.mouse.click(tile.left + tile.width / 2, tile.top + tile.height / 2, { button: "right" });
  await waitFor(x.page, () => document.querySelectorAll(".dgc-pop .dgc-menu-row").length > 0);
  return (await dockNow(x.page)).menu;
}
async function openSites(x) {
  await menu(x);
  await x.page.evaluate(() => [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].find((r) => /Sites Pips can use/.test(r.textContent)).click());
  await waitFor(x.page, () => document.querySelectorAll("dialog.yb-sites-dialog[open] li.yb-site .yb-site-modes").length > 0 || /No sites yet/.test(document.querySelector("dialog.yb-sites-dialog .yb-sites-status")?.textContent || ""));
}
const panelNow = (page) => page.evaluate(() => {
  const d = document.querySelector("dialog.yb-sites-dialog");
  if (!d) return null;
  const r = d.getBoundingClientRect(), shown = (n) => !!n && !n.hidden && n.getBoundingClientRect().height > 0;
  return { title: d.querySelector("h2").textContent, intro: d.querySelector(".yb-sites-intro").textContent, status: shown(d.querySelector(".yb-sites-status")) ? d.querySelector(".yb-sites-status").textContent : "",
    waiting: shown(d.querySelector(".yb-sites-waiting")) ? d.querySelector(".yb-sites-waiting").textContent : "", said: d.querySelector(".yb-sites-said")?.textContent || "",
    sites: [...d.querySelectorAll("li.yb-site")].map((li) => ({ site: li.dataset.site, name: li.querySelector(".yb-site-name")?.textContent, tags: [...li.querySelectorAll(".yb-site-tag")].map((t) => t.textContent),
      mode: li.querySelector(".yb-site-modes input:checked")?.value || "", pips: [...li.querySelectorAll(".yb-site-pip")].map((l) => [l.textContent.trim(), l.querySelector("input").checked]),
      line: li.querySelector(".yb-site-line:last-of-type")?.textContent || [...li.querySelectorAll(".yb-site-line")].at(-1)?.textContent, confirm: li.querySelector(".yb-site-confirm p")?.textContent || "",
      error: shown(li.querySelector(".yb-site-error")) ? li.querySelector(".yb-site-error").textContent : "", busy: li.classList.contains("busy") })),
    buttons: [...d.querySelectorAll("button")].filter((b) => b.getBoundingClientRect().height > 0).map((b) => ({ text: b.textContent.trim(), radius: getComputedStyle(b).borderTopLeftRadius, height: b.getBoundingClientRect().height, right: b.getBoundingClientRect().right })),
    modes: [...d.querySelectorAll("label.yb-site-mode")].map((l) => ({ radius: getComputedStyle(l).borderTopLeftRadius, height: l.getBoundingClientRect().height, right: l.getBoundingClientRect().right, clipped: l.querySelector("span").scrollWidth > l.querySelector("span").clientWidth + 1 })),
    rows: [...d.querySelectorAll("li.yb-site")].map((li) => ({ radius: getComputedStyle(li).borderTopLeftRadius, right: li.getBoundingClientRect().right })),
    ground: getComputedStyle(d).backgroundColor, left: r.left, right: r.right, top: r.top, bottom: r.bottom,
    overflow: document.documentElement.scrollWidth > innerWidth || d.scrollWidth > d.clientWidth + 1, focus: document.activeElement?.dataset?.k || document.activeElement?.textContent?.trim() || "" };
});
const pick = (page, site, value) => page.click(`dialog.yb-sites-dialog li[data-site="${site}"] label.yb-site-mode:has(input[value="${value}"])`);
const settled = (page) => waitFor(page, () => !document.querySelector("dialog.yb-sites-dialog li.yb-site.busy") && window.__asking === 0);

test("the dock's Your Browser menu offers Sites Pips can use…, with how many are new; an older DGC, nothing", async (t) => {
  if (skipOrFail(t)) return;
  let x = await sideBar();
  try { assert.deepEqual(await menu(x), ["Open Your Browser", "Sites Pips can use… (2 new)", "Clear browsing data…"]); } finally { await x.close(); }
  x = await sideBar(440, "dark-modern", ready(), 112);
  try { assert.deepEqual(await menu(x), ["Open Your Browser", "Clear browsing data…"]); } finally { await x.close(); }
});

test("the panel: every site, the new ones first, each with its choice and who may use it; opening it is looking", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar();
  try {
    await openSites(x);
    const p = await panelNow(x.page);
    assert.equal(p.title, "Sites Pips can use");
    assert.equal(p.focus, "Sites Pips can use", "the keys start at its title, never a ring on a choice nobody touched");
    assert.match(p.intro, /only on the sites you let it use; anywhere else it asks you first in its chat/);
    // (A site let from a Pip's card is on the list with no sign-in: the panel never says "signed in" of the whole list.)
    assert.match(p.intro, /^The sites your Pips may use in Your Browser\. /);
    assert.doesNotMatch(p.intro, /sites you’re signed in to/);
    assert.deepEqual(await x.page.evaluate(() => [...document.querySelectorAll("dialog.yb-sites-dialog li.yb-site")].map((li) => [li.dataset.site, li.querySelector('[data-k="out"]').textContent, li.querySelector('[data-k="out"]').getAttribute("aria-label")])),
      [["github.com", "Sign out", "Sign out of github.com"], ["northwind-bank.com", "Sign out", "Sign out of northwind-bank.com"], ["lanestore.com", "Remove", "Remove lanestore.com"]],
      "Sign out only where there is a sign-in: a site a Pip was let use from its card is removed");
    assert.deepEqual(p.sites.map((s) => [s.site, s.tags, s.mode]), [["github.com", ["New"], "all"], ["northwind-bank.com", ["New", "Bank or payment"], "none"], ["lanestore.com", [], "some"]]);
    assert.equal(p.sites[0].line, "Every Pip may use your sign-in here, each in its own tab.");
    assert.equal(p.sites[1].line, "No Pip yet. It’s a bank or payment site: a Pip that needs it asks you first.");
    assert.deepEqual(p.sites[2].pips, [["Ava", true], ["Ben", false]], "Some Pips: every Pip, the chosen ones ticked");
    assert.equal(p.sites[2].line, "Only Ava may use this site.", "let from a card: no sign-in is claimed");
    await waitFor(x.page, () => window.__answered.includes("seen_your_browser_sites"));
    assert.deepEqual((await requests(x.page, "seen_your_browser_sites"))[0], { type: "seen_your_browser_sites" });
    assert.deepEqual((await requests(x.page, "get_your_browser"))[0], { type: "get_your_browser" });
    await x.page.keyboard.press("Escape");
    assert.equal(await panelNow(x.page), null, "Escape closes it");
    assert.deepEqual(await menu(x), ["Open Your Browser", "Sites Pips can use…", "Clear browsing data…"], "looked at: no more new");
  } finally { await x.close(); }
});

test("a change is asked of DGC at once, one site at a time, and the row says who may use it now", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(440, "light-modern");
  try {
    await openSites(x);
    await x.page.click('dialog.yb-sites-dialog li[data-site="lanestore.com"] .yb-site-pip:has-text("Ben")');
    await settled(x.page);
    await pick(x.page, "github.com", "none"); await settled(x.page);
    await pick(x.page, "github.com", "all"); await settled(x.page);
    // (Some Pips on a site no Pip may use yet: its Pips to tick, nothing asked until one is.)
    await pick(x.page, "northwind-bank.com", "some");
    let p = await panelNow(x.page);
    assert.deepEqual(p.sites[1].pips, [["Ava", false], ["Ben", false]]);
    assert.equal(p.sites[1].line, "Tick the Pips that may use your sign-in here.");
    await x.page.click('dialog.yb-sites-dialog li[data-site="northwind-bank.com"] .yb-site-pip:has-text("Ava")'); await settled(x.page);
    assert.deepEqual((await requests(x.page, "set_your_browser_site")).map((r) => ({ ...r })), [
      { type: "set_your_browser_site", site: "lanestore.com", mode: "chosen", pips: [AVA, BEN] },
      { type: "set_your_browser_site", site: "github.com", mode: "chosen", pips: [] },
      { type: "set_your_browser_site", site: "github.com", mode: "all" },
      { type: "set_your_browser_site", site: "northwind-bank.com", mode: "chosen", pips: [AVA] }]);
    p = await panelNow(x.page);
    assert.deepEqual(p.sites.map((s) => [s.site, s.mode, s.line]), [["github.com", "all", "Every Pip may use your sign-in here, each in its own tab."],
      ["northwind-bank.com", "some", "Only Ava may use your sign-in here."], ["lanestore.com", "some", "Only Ava and Ben may use this site."]]);
    assert.match(p.said, /northwind-bank\.com: Only Ava may use your sign-in here\./, "said for a reader too");
    assert.equal(p.status, "", "(and nothing more on the page: the row shows it)");
    // A grant a chat's card made (Ava on lanestore.com) is taken back here: untick her.
    await x.page.click('dialog.yb-sites-dialog li[data-site="lanestore.com"] .yb-site-pip:has-text("Ava")'); await settled(x.page);
    assert.deepEqual((await requests(x.page, "set_your_browser_site")).at(-1), { type: "set_your_browser_site", site: "lanestore.com", mode: "chosen", pips: [BEN] });
  } finally { await x.close(); }
});

test("Sign out is asked once more in its row; Keep keeps it, Sign out takes it off and says what waits", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar();
  try {
    await openSites(x);
    await x.page.click('dialog.yb-sites-dialog li[data-site="github.com"] [data-k="out"]');
    let p = await panelNow(x.page);
    assert.equal(p.sites[0].confirm, "Sign out of github.com? No Pip can use it, and Your Browser clears your sign-in there.");
    assert.equal(p.focus, "keep", "the keys on Keep");
    await x.page.keyboard.press("Enter");
    p = await panelNow(x.page);
    assert.equal(p.sites[0].confirm, "");
    assert.deepEqual(await requests(x.page, "sign_out_your_browser_site"), []);
    await x.page.click('dialog.yb-sites-dialog li[data-site="github.com"] [data-k="out"]');
    await x.page.click('dialog.yb-sites-dialog li[data-site="github.com"] [data-k="out-yes"]');
    await waitFor(x.page, () => !document.querySelector('dialog.yb-sites-dialog li[data-site="github.com"]'));
    assert.deepEqual(await requests(x.page, "sign_out_your_browser_site"), [{ type: "sign_out_your_browser_site", site: "github.com" }]);
    p = await panelNow(x.page);
    assert.deepEqual(p.sites.map((s) => s.site), ["northwind-bank.com", "lanestore.com"]);
    assert.equal(p.waiting, "Signing out of github.com: Your Browser clears your sign-in there as soon as it runs.");
    assert.equal(p.said, "Signed out of github.com.");
  } finally { await x.close(); }
});

test("a site with no sign-in (let from a Pip's card) is removed, in words that claim no sign-in", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar();
  try {
    await openSites(x);
    await x.page.click('dialog.yb-sites-dialog li[data-site="lanestore.com"] [data-k="out"]');
    let p = await panelNow(x.page);
    assert.equal(p.sites[2].confirm, "Remove lanestore.com? No Pip can use it until you allow it again.");
    assert.equal(await x.page.evaluate(() => document.querySelector('dialog.yb-sites-dialog li[data-site="lanestore.com"] [data-k="out-yes"]').textContent), "Remove");
    await x.page.click('dialog.yb-sites-dialog li[data-site="lanestore.com"] [data-k="out-yes"]');
    await waitFor(x.page, () => !document.querySelector('dialog.yb-sites-dialog li[data-site="lanestore.com"]'));
    assert.deepEqual(await requests(x.page, "sign_out_your_browser_site"), [{ type: "sign_out_your_browser_site", site: "lanestore.com" }]);
    p = await panelNow(x.page);
    assert.equal(p.said, "Removed lanestore.com.");
    assert.doesNotMatch(p.waiting, /lanestore/, "nothing says it is signing out of a site that had no sign-in");
  } finally { await x.close(); }
});

test("a refusal is said in that site's row, which shows what DGC kept", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(440, "dark-modern", ready({ refuseSite: "github.com" }));
  try {
    await openSites(x);
    await pick(x.page, "github.com", "none"); await settled(x.page);
    const p = await panelNow(x.page);
    assert.equal(p.sites[0].error, "DGC couldn't change that site just now.");
    assert.equal(p.sites[0].mode, "all", "as DGC kept it");
    assert.equal(await x.page.evaluate(() => document.querySelector('dialog.yb-sites-dialog li[data-site="github.com"] .yb-site-error').getAttribute("role")), "alert");
  } finally { await x.close(); }
});

test("no sites yet: one line says how one gets here", async (t) => {
  if (skipOrFail(t)) return;
  const x = await sideBar(440, "dark-modern", ready({ sites: [], recent: { links: [], open: false, available: true, reason: "", lanes: [], new_sites: 0 } }));
  try {
    await openSites(x);
    const p = await panelNow(x.page);
    assert.deepEqual(p.sites, []);
    assert.equal(p.status, "No sites yet. Sign in to a site in Your Browser and it shows here, for you to choose which Pips may use it.");
  } finally { await x.close(); }
});

const alpha = (c) => { const s = String(c || ""); if (/transparent/.test(s)) return 0; const slash = s.match(/\/\s*([\d.]+)\s*\)/); if (slash) return Number(slash[1]);
  const n = s.match(/-?[\d.]+/g)?.map(Number) || []; return s.startsWith("rgba") && n.length >= 4 ? n[3] : 1; };
for (const width of [300, 440, 700]) {
  for (const theme of ["dark-modern", "light-modern", "cursor"]) {
    test(`the panel at ${width} px, ${theme}: inside the page, the one corner, button heights, a solid ground`, async (t) => {
      if (skipOrFail(t)) return;
      const x = await sideBar(width, theme === "cursor" ? "dark-modern" : theme);
      try {
        if (theme === "cursor") { await x.page.evaluate(() => document.documentElement.style.setProperty("--vscode-input-background", "#ffffff0d")); await x.page.waitForTimeout(250); }
        await openSites(x);
        await pick(x.page, "github.com", "some");
        const p = await panelNow(x.page);
        assert.ok(p.left >= 8 && p.right <= width - 8, `inside the side bar (${p.left}..${p.right} of ${width})`);
        assert.ok(p.top >= 0 && p.bottom <= 760, "inside the page's height");
        assert.equal(p.overflow, false, "nothing runs off sideways");
        assert.ok(alpha(p.ground) >= 0.999, `one solid ground (${p.ground})`);
        for (const b of p.buttons) { assert.equal(b.radius, "6px", b.text); assert.ok(b.height >= 22 && b.height <= 32, `${b.text}: a button's height (${b.height})`); assert.ok(b.right <= p.right, `${b.text} inside`); }
        for (const m of p.modes) { assert.equal(m.radius, "6px"); assert.ok(m.height >= 22 && m.height <= 32); assert.equal(m.clipped, false, "each choice's words whole"); assert.ok(m.right <= p.right); }
        for (const r of p.rows) { assert.equal(r.radius, "6px"); assert.ok(r.right <= p.right); }
        if (PICTURES) await x.page.screenshot({ path: `${PICTURES}/sites-panel-${width}-${theme.replace(/-modern$/, "")}.png` });
      } finally { await x.close(); }
    });
  }
}

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

test("the bridge lets the Sites panel's commands through with their fields only, never to an older DGC", () => {
  const b = bridge(113), refused = "Your Browser can't be asked that from here.";
  b.ask("g", { type: "get_your_browser" });
  b.ask("s1", { type: "set_your_browser_site", site: "github.com", mode: "all" });
  b.ask("s2", { type: "set_your_browser_site", site: "github.com", mode: "chosen", pips: [AVA] });
  b.ask("s3", { type: "set_your_browser_site", site: "github.com", mode: "chosen", pips: [] });
  b.ask("o", { type: "sign_out_your_browser_site", site: "github.com" });
  b.ask("n", { type: "seen_your_browser_sites" });
  for (const [id, bad] of [["x1", { type: "get_your_browser", pip_id: AVA }], ["x2", { type: "set_your_browser_site", site: "github.com", mode: "all", pips: [AVA] }],
    ["x3", { type: "set_your_browser_site", site: "github.com", mode: "every" }], ["x4", { type: "set_your_browser_site", site: "a b", mode: "all" }],
    ["x5", { type: "set_your_browser_site", site: "github.com", mode: "chosen", pips: ["nope"] }], ["x6", { type: "sign_out_your_browser_site", site: "github.com", all: true }],
    ["x7", { type: "seen_your_browser_sites", site: "github.com" }], ["x8", { type: "set_your_browser_site", site: "github.com", mode: "all", owner: "me" }]]) b.ask(id, bad);
  assert.deepEqual(b.controls().map((r) => ({ ...r, request_id: undefined })), [
    { type: "get_your_browser", request_id: undefined }, { type: "set_your_browser_site", site: "github.com", mode: "all", request_id: undefined },
    { type: "set_your_browser_site", site: "github.com", mode: "chosen", pips: [AVA], request_id: undefined }, { type: "set_your_browser_site", site: "github.com", mode: "chosen", pips: [], request_id: undefined },
    { type: "sign_out_your_browser_site", site: "github.com", request_id: undefined }, { type: "seen_your_browser_sites", request_id: undefined }]);
  assert.deepEqual(b.replies().map((m) => m.error?.message), Array(8).fill(refused));
  const older = bridge(112);
  older.ask("g", { type: "get_your_browser" });
  older.ask("n", { type: "seen_your_browser_sites" });
  assert.deepEqual(older.controls(), []);
  assert.deepEqual(older.replies().map((m) => m.error?.message), Array(2).fill("Update DGC to choose which sites Pips may use in Your Browser."));
});

test("a page is told the sites and the Pips, never the person's own tabs", () => {
  const b = bridge(113);
  b.ask("g", { type: "get_your_browser" });
  const sent = b.controls()[0];
  b.editor.event({ type: "pips_result", request_id: sent.request_id, command: "get_your_browser", ok: true,
    result: { kind: "host_profile", weaker: true, available: true, reason: "", sites: SITES(), pips: PIPS, signing_out: ["old.example"],
      yours: { open: true, tabs: [{ title: "My bank statement", url: "https://bank.example/statement?id=42" }], error: "" },
      lanes: [{ pip_id: AVA, name: "Ava", title: "Cart", url: "https://lanestore.com/cart" }], chrome_account: true, view: "window", install: null, chrome: "installed" } });
  const reply = b.replies().find((m) => m.id === "g");
  assert.equal(reply.ok, true);
  assert.deepEqual(Object.keys(reply.result).sort(), ["available", "kind", "pips", "reason", "signing_out", "sites", "weaker"]);
  assert.equal(JSON.stringify(reply).includes("statement"), false, "nothing of the person's own tabs");
});

// ---- a Pip's page -------------------------------------------------------------------------------------------------------
// (The Pips view as the side bar mounts it, on the One Pips stand-in: Mornings is a Personal Pip with a computer.)
const FERN = "pip_" + "f".repeat(32);
const MINE = [{ pip_id: MORNINGS, name: "Mornings" }, { pip_id: FERN, name: "Fern" }];
const pageSites = () => [
  { site: "lanestore.com", shown: "lanestore.com", mode: "chosen", money: false, pips: [{ pip_id: MORNINGS, name: "Mornings" }], new: false },
  { site: "github.com", shown: "github.com", mode: "all", money: false, pips: [], new: false },
  { site: "northwind-bank.com", shown: "northwind-bank.com", mode: "chosen", money: true, pips: [], new: false }];
const opened = [];
after(() => opened.forEach((w) => w.close()));
async function pipPage({ api = 113 } = {}) {
  const x = onePips({ api, scene: { mine: true } });
  opened.push(x.w);
  const state = { sites: pageSites() }, own = x.backend.answer.bind(x.backend);
  x.backend.answer = (r) => {
    if (r.type === "get_your_browser") { x.state.requests.push({ ...r }); return { kind: "host_profile", weaker: true, available: true, reason: "", sites: state.sites, pips: MINE, signing_out: [] }; }
    if (r.type === "set_your_browser_site") { x.state.requests.push(JSON.parse(JSON.stringify(r))); const site = state.sites.find((v) => v.site === r.site);
      site.mode = r.mode; site.pips = (r.pips || []).map((id) => MINE.find((m) => m.pip_id === id)); return { site }; }
    if (r.type === "seen_your_browser_sites") { x.state.requests.push({ ...r }); return { ok: true }; }
    return own(r);
  };
  await x.drain(); await x.openPip(MORNINGS); await x.menu("job");
  const click = async (sel) => { const el = x.$(sel); assert.ok(el, "Missing " + sel); el.click(); await x.drain(); };
  return { ...x, click, state, asked: (type) => x.requests(type).map((r) => { const { request_id, ...rest } = r; return rest; }) };
}
const group = (x) => x.$('[aria-label="Sites in Your Browser"]');

test("a Pip's page: its sites in Your Browser (Remove), the others (Let it use), and All sites…", async () => {
  const x = await pipPage();
  const g = group(x);
  assert.ok(g, "the section on its page");
  const rows = [...g.querySelectorAll("[data-yb-pip-site]")].map((li) => [li.dataset.ybPipSite, li.querySelector("small").textContent, li.querySelector("button").textContent]);
  assert.deepEqual(rows, [["lanestore.com", "Only Mornings", "Remove"], ["github.com", "Every Pip may use it", "Remove"], ["northwind-bank.com", "No Pip yet · Bank or payment", "Let Mornings use it"]]);
  assert.match(g.textContent, /Other sites in Your Browser/); assert.doesNotMatch(g.textContent, /signed in to/, "lanestore.com was let from a card: no sign-in is claimed for the list");
  // Its card's grant (lanestore.com, chosen for it alone): Remove takes it back at once.
  await x.click('[data-yb-pip-remove="lanestore.com"]');
  assert.deepEqual(x.asked("set_your_browser_site")[0], { type: "set_your_browser_site", site: "lanestore.com", mode: "chosen", pips: [] });
  assert.match(x.text(), /Mornings won’t use lanestore\.com in Your Browser now\./);
  // An All Pips site asks first: the others keep it.
  await x.click('[data-yb-pip-ask-remove="github.com"]');
  assert.match(group(x).textContent, /Every Pip may use it\. Take it from Mornings only\?/);
  await x.click('[data-yb-pip-remove="github.com"]');
  assert.deepEqual(x.asked("set_your_browser_site")[1], { type: "set_your_browser_site", site: "github.com", mode: "chosen", pips: [FERN] });
  await x.click('[data-yb-pip-add="northwind-bank.com"]');
  assert.deepEqual(x.asked("set_your_browser_site")[2], { type: "set_your_browser_site", site: "northwind-bank.com", mode: "chosen", pips: [MORNINGS] });
  assert.match(x.text(), /Mornings may use northwind-bank\.com in Your Browser now\./);
  // All sites…: the one Sites panel, on this page.
  await x.click("[data-yb-sites-all]");
  await x.drain();
  const dialog = x.$("dialog.yb-sites-dialog");
  assert.ok(dialog, "the Sites panel opens, in the Pips view's own root (its look comes with the view)");
  assert.deepEqual([...dialog.querySelectorAll("li.yb-site")].map((li) => li.dataset.site).sort(), ["github.com", "lanestore.com", "northwind-bank.com"]);
  assert.ok(x.asked("seen_your_browser_sites").length >= 1);
});

test("an older DGC: no section, and nothing asked", async () => {
  const x = await pipPage({ api: 112 });
  assert.equal(group(x), null);
  assert.equal(x.asked("get_your_browser").length, 0);
});
