// One kind of Pip on screen, the second half (16 Nov, Pips API 103): what was still only a Pip without a folder's is
// every Pip's, gate by gate. In real Chromium on the real Pips page (test/support/one-pips-scene.mjs): GST watchdog is
// a Pip with a folder. Each test also opens a DGC that answers Pips API 102, which keeps the hiding it had.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { GST, LIME, openOnePips } from "./support/one-pips-scene.mjs";

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
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

const hex = (c) => c.repeat(32), now = new Date().toISOString();
const CHAT = { [GST]: { messages: [{ id: "msg_" + hex("1"), role: "user", text: "How did tonight's check go?", run_id: "run_" + hex("8"), status: "succeeded" },
  { id: "msg_" + hex("2"), role: "assistant", text: "All green tonight. Nothing new in the GST code.", run_id: "run_" + hex("8"), status: "succeeded" }] } };
const APPS = [{ id: "gmail", name: "Gmail", kind: "app", on: true, accounts: ["me@example.com"] }, { id: "github", name: "GitHub", kind: "plugin", on: false, accounts: [] }];
const LINK = { id: "applink_" + hex("1"), pip_id: GST, toolkit: "gmail", app: "Gmail", reason: "To read the supplier's invoices.", status: "requested", label: null, error: null, updated_at: now };
const PLUGIN_CARD = { id: "pipplugin_" + hex("1"), pip_id: GST, plugin: "github", name: "GitHub", reason: "To read the open issues.", status: "requested", installed: true, money: false, servers: ["github"], updated_at: now };
const PLUGINS = { pip_id: GST, plugins: [PLUGIN_CARD], installed: [{ plugin: "github", name: "GitHub", money: false, servers: ["github"] }] };
const BORROW = { id: "pipborrow_" + hex("1"), pip_id: GST, workspace_id: LIME, status: "requested", sites: ["portal.example.com"], origins: ["https://portal.example.com"], why: "To read the filing status.",
  reachable: true, unreachable: "", unattended: false, minutes: 15, chrome: "Chrome", ended: "", sent: [], created_at: now, expires_at: null, allowed_at: null, started_at: null, ended_at: null };
const KEY = { id: "pipkey_" + hex("1"), pip_id: GST, name: "Tax portal", why: "To file the return.", host: "api.portal.example.com", status: "saved" };
const EYES = { eyes: { pip_id: GST, model: "qwen3-coder:480b", sees: false, choice: "ask", vision_model: null } };
const EVERY = { fix: "none", posts: false, waiting: false, attention: false, computers: 1, convs: true, chat: CHAT, apps: APPS };
const open = (api, scene = {}) => openOnePips(browser, { width: 700, api, scene: { ...EVERY, ...scene, answers: { ...(scene.answers || {}) } } });
/** One scene on a DGC of Pips API 103 and on one of 102: `look(x)` reads what the test is about from each. */
async function both(scene, look, { page = false } = {}) {
  const out = [];
  for (const api of [103, 102]) {
    const x = await open(api, scene);
    try { await x.openPip(GST); await x.page.waitForTimeout(400); if (page) await toPage(x); out.push(await look(x)); assert.deepEqual(x.errors, [], `no page error (API ${api})`); }
    finally { await x.close(); }
  }
  return out;
}
const toPage = async (x) => { await x.inPips((root) => [...root.querySelectorAll(".pip-topbar .pip-menu [data-tab]")].find((b) => b.dataset.tab === "job").click()); await x.waitIn(".pip-page"); await x.page.waitForTimeout(500); };
const type = async (x, words) => { await x.inPips((root) => root.querySelector("#chatText").focus()); await x.page.keyboard.type(words); await x.page.waitForTimeout(350); };
const asked = async (x, kind) => (await x.requests(kind)).filter((r) => r.pip_id === GST).length;
const options = (x) => x.inPips((root) => [...root.querySelectorAll("#chat-pop [role=option]")].map((r) => r.textContent.trim()));
const has = (x, selector) => x.inPips((root, s) => !!root.querySelector(s), selector);
const words = (x, selector = "#app") => x.inPips((root, s) => (root.querySelector(s)?.innerText || "").replace(/\s+/g, " "), selector);
const press = (x, text) => x.inPips((root, t) => { const b = [...root.querySelectorAll("button")].find((n) => n.textContent.trim() === t && !n.disabled); b?.click(); return !!b; }, text);

test("a Pip with a folder now has /setup in its \"/\" menu", async (t) => {
  if (skipOrFail(t)) return;
  const [now103, old] = await both({}, async (x) => { await type(x, "/"); await x.waitIn("#chat-pop [role=option]", 4000).catch(() => {}); return options(x); });
  assert.ok(now103.some((r) => /^\/?setup/.test(r)), `/setup is listed (${now103.join(" | ")})`);
  assert.ok(!old.some((r) => /^\/?setup/.test(r)), "an older DGC: not offered");
});

test("a Pip with a folder now connects an app: its card in the chat, and the account on its page", async (t) => {
  if (skipOrFail(t)) return;
  const scene = { answers: { list_pip_app_links: { pip_id: GST, links: [LINK], composio: true } } };
  const [a, b] = await both(scene, async (x) => ({ asked: await asked(x, "list_pip_app_links"), card: await has(x, `[data-app-link="${LINK.id}"]`), said: await words(x) }));
  assert.ok(a.asked > 0, "its app links are asked for"); assert.equal(a.card, true, "the card to connect Gmail is in its chat"); assert.match(a.said, /supplier's invoices/);
  assert.equal(b.asked, 0, "an older DGC is not asked"); assert.equal(b.card, false);
  const linked = { answers: { list_pip_app_links: { pip_id: GST, links: [{ ...LINK, status: "connected", label: "me@example.com", server: "composio", account: "ca_abc123" }], composio: true } } };
  const [c, d] = await both(linked, async (x) => ({ asked: await asked(x, "list_pip_app_links"), row: await words(x, ".pip-page") }), { page: true });
  assert.ok(c.asked > 0); assert.match(c.row, /Disconnect|me@example\.com/, "its page names the account, with Disconnect");
  assert.equal(d.asked, 0, "an older DGC: no linked account on its page");
});

test("a Pip with a folder now has plugins: in its @ list, each with its switch, and a plugin's card in its chat", async (t) => {
  if (skipOrFail(t)) return;
  const scene = { answers: { list_pip_plugins: PLUGINS } };
  const [a, b] = await both(scene, async (x) => { const card = await has(x, `[data-plugin-card="${PLUGIN_CARD.id}"]`), n = await asked(x, "list_pip_plugins");
    await type(x, "@"); await x.waitIn("#chat-pop [role=option]", 4000).catch(() => {}); return { card, asked: n, at: await options(x) }; });
  assert.ok(a.asked > 0, "its plugins are asked for"); assert.equal(a.card, true, "the card asking to use GitHub is in its chat");
  assert.ok(a.at.some((r) => /GitHub/.test(r)), `@ offers the plugin (${a.at.join(" | ")})`);
  assert.equal(b.asked, 0, "an older DGC is not asked"); assert.equal(b.card, false); assert.ok(!b.at.some((r) => /GitHub/.test(r)));
  const [c, d] = await both(scene, (x) => has(x, '[data-pip-app-switch="github"]'), { page: true });
  assert.equal(c, true, "\"Apps it can use\" lists the plugin with its switch"); assert.equal(d, false, "an older DGC: plugins stay off that list");
  const allowed = { answers: { list_pip_plugins: { ...PLUGINS, plugins: [{ ...PLUGIN_CARD, status: "allowed" }] } } };
  const [e, f] = await both(allowed, (x) => has(x, '.pip-page section[aria-label="Plugins"]'), { page: true });
  assert.equal(e, true, "its page has the Plugins section"); assert.equal(f, false);
});

test("a Pip with a folder now drafts an email, an event or an app action: its drafts are asked for", async (t) => {
  if (skipOrFail(t)) return;
  const empty = { drafts: [], next_cursor: null };
  const kinds = ["list_pip_message_drafts", "list_pip_calendar_drafts", "list_pip_connector_drafts"];
  const [a, b] = await both({ answers: Object.fromEntries(kinds.map((k) => [k, empty])) }, async (x) => { const out = {}; for (const k of kinds) out[k] = await asked(x, k); return out; });
  for (const k of kinds) { assert.ok(a[k] > 0, `${k} is asked for it`); assert.equal(b[k], 0, `an older DGC: ${k} is not`); }
});

test("a Pip with a folder now may borrow your Chrome: the card asking is in its chat", async (t) => {
  if (skipOrFail(t)) return;
  const [a, b] = await both({ answers: { list_pip_borrows: { pip_id: GST, borrows: [BORROW] } } }, async (x) => ({ asked: await asked(x, "list_pip_borrows"), card: await has(x, "[data-borrow-card]") }));
  assert.ok(a.asked > 0); assert.equal(a.card, true, "the card is drawn");
  assert.equal(b.asked, 0, "an older DGC is not asked"); assert.equal(b.card, false);
});

test("a Pip with a folder now has its own API keys on its page", async (t) => {
  if (skipOrFail(t)) return;
  const [a, b] = await both({ answers: { list_pip_keys: { pip_id: GST, keys: [KEY] } } }, async (x) => ({ asked: await asked(x, "list_pip_keys"), row: await has(x, `.pip-page [data-pip-key="${KEY.id}"], .pip-page [data-pip-key-ask-remove="${KEY.id}"]`), said: await words(x, ".pip-page") }), { page: true });
  assert.ok(a.asked > 0, "its keys are asked for"); assert.ok(a.row || /Tax portal/.test(a.said), "the saved key is on its page");
  assert.equal(b.asked, 0, "an older DGC is not asked"); assert.ok(!/Tax portal/.test(b.said));
});

test("a Pip with a folder now says how it sees on its page", async (t) => {
  if (skipOrFail(t)) return;
  const [a, b] = await both({ answers: { get_pip_eyes: EYES } }, async (x) => ({ asked: await asked(x, "get_pip_eyes"), section: await has(x, '.pip-page section[aria-label="Seeing"]') }), { page: true });
  assert.ok(a.asked > 0); assert.equal(a.section, true, "the Seeing section is on its page");
  assert.equal(b.asked, 0, "an older DGC is not asked"); assert.equal(b.section, false);
});

test("a Pip with a folder now can have its computer removed, and be given one again", async (t) => {
  if (skipOrFail(t)) return;
  const [a, b] = await both({}, async (x) => { const offered = await press(x, "Remove…"); await x.page.waitForTimeout(300);
    const title = await x.inPips((root) => root.querySelector("#review-root .dialog h2, #review-root .dialog h3")?.textContent || "");
    if (offered) { await x.click("#review-confirm"); await x.page.waitForTimeout(400); }
    return { offered, title, sent: (await x.requests("propose_pip_update")).filter((r) => r.pip_id === GST).map((r) => r.changes) }; }, { page: true });
  assert.equal(a.offered, true, "Remove… is beside its computer"); assert.match(a.title, /Remove GST watchdog's computer\?/);
  assert.deepEqual(a.sent, [{ computer_plan: null }], "the removal is sent as any Pip's");
  assert.equal(b.offered, false, "an older DGC: its computer is opened here, never removed"); assert.deepEqual(b.sent, []);
  const none = { answers: { get_pip_computer: { computer: { pip_id: GST, granted: false, available: true, reason: "", pending: 0, actions: [] } } } };
  const [c, d] = await both(none, async (x) => { const offered = await press(x, "Give it a computer…"); await x.page.waitForTimeout(300);
    if (offered) { await x.click("#review-confirm"); await x.page.waitForTimeout(400); }
    return { offered, sent: (await x.requests("propose_pip_update")).filter((r) => r.pip_id === GST).map((r) => r.changes) }; }, { page: true });
  assert.equal(c.offered, true, "without one, its page offers one"); assert.deepEqual(c.sent, [{ computer_plan: { schema_version: 1 } }]);
  assert.equal(d.offered, false, "an older DGC: nothing to give");
});

test("a Pip with a folder now reads \"Computer removed\" on the waiting change that takes its computer away", async (t) => {
  if (skipOrFail(t)) return;
  // (As DGC saves it: the removal keeps `computer_plan: null` in the proposal, and the Pip's own was null already.)
  const pending = [{ id: "prop_" + hex("7"), pip_id: GST, expected_version: 3, approval_status: "pending", reason: "Remove this Pip's computer.", definition: { computer_plan: null } }];
  const x = await open(103, { pending });
  try {
    await x.openPip(GST); await x.page.waitForTimeout(400); await toPage(x);
    assert.equal(await press(x, "Archive…"), true, "premise: Archive lists the changes that wait"); await x.page.waitForTimeout(300);
    assert.match(await words(x, "#review-root .waiting-list"), /Computer removed/);
  } finally { await x.close(); }
});

test("a Pip with a folder now takes an @ project when it has its computer, whatever its plan says", async (t) => {
  if (skipOrFail(t)) return;
  const projects = { projects: [{ workspace_id: "ws_" + hex("3"), name: "garden" }] };
  const out = [];
  for (const scene of [{}, { answers: { get_pip_computer: { computer: { pip_id: GST, granted: false, available: true, reason: "", pending: 0, actions: [] } } } }]) {
    const x = await open(103, { ...scene, answers: { ...(scene.answers || {}), list_pip_project_choices: projects } });
    try {
      // (The marks a message carries are on, as the extension says when DGC keeps them.)
      await x.send({ type: "pipsConnection", apiVersion: 103, generation: 2, connected: true, supported: true, enabled: true, folder: true, projectFolder: "", home: "/home/me", windowFolder: { folder: "/home/me/code/shop", name: "shop" }, displayMentions: true });
      await x.page.waitForTimeout(500); await x.waitIn(".pips-one-list .pip-row");
      await x.openPip(GST); await x.page.waitForTimeout(500);
      await type(x, "@"); await x.page.waitForTimeout(400); await x.page.keyboard.type("gar"); await x.page.waitForTimeout(500);
      const rows = await options(x);
      if (rows.some((r) => /garden/i.test(r))) { await x.page.keyboard.press("Enter"); await x.page.waitForTimeout(400); }
      out.push({ rows, marks: await x.inPips((root) => [...root.querySelectorAll("#chatText *")].map((n) => n.textContent.trim()).filter(Boolean)), said: await words(x) });
      assert.deepEqual(x.errors, []);
    } finally { await x.close(); }
  }
  const [boxed, bare] = out;
  assert.ok(boxed.rows.some((r) => /garden/i.test(r)), `premise: @ offers the project (${boxed.rows.join(" | ")})`);
  assert.ok(boxed.marks.some((p) => /garden/i.test(p)), `it has its computer: the project's mark goes in the box (${boxed.marks.join(" | ")})`);
  assert.ok(!bare.marks.some((p) => /garden/i.test(p)), "its computer was removed: no mark goes in");
});

test("a Pip with a folder now is told what it can do in any Pip's words, and nothing says Personal only", async (t) => {
  if (skipOrFail(t)) return;
  const x = await open(103, { answers: { get_pip_eyes: EYES, list_pip_keys: { pip_id: GST, keys: [KEY] }, list_pip_plugins: PLUGINS, list_pip_app_links: { pip_id: GST, links: [LINK], composio: true } } });
  try {
    await x.openPip(GST); await x.page.waitForTimeout(400);
    const chat = await words(x); await toPage(x); const page = await words(x);
    for (const said of [chat, page]) assert.doesNotMatch(said, /Personal only|Personal Pips? only|only (for )?a Personal Pip/i);
  } finally { await x.close(); }
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../src/pipsClient.js", import.meta.url), "utf8");
  for (const reason of [/reason:'[^']*[Pp]ersonal Pip[^']*'/g]) assert.deepEqual(src.match(reason) || [], [], "what DGC records for a change names no kind of Pip");
});
