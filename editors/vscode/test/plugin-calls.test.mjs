// A plugin's action card in plain words and with the plugin's own logo, the same in ChatDGC, a Pip's chat and Work
// (media/pluginCalls.js). Composio's multi-execute shows each app call as app · action · its main inputs, "Gmail · Fetch
// emails · 5 from Inbox · through Composio", never its plumbing or raw JSON; every action an Allow covers is listed, a
// call that sends or changes something shows every input it sends under its line with no click (an email's recipient,
// subject and body), and all of it as sent is one click away, without Edit; the mark is always the logo of the
// plugin DGC calls (Composio's), never the app inside it, and its first letter only when it has none.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import "../media/pluginCalls.js";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const calls = globalThis.DgcPluginCalls;
const READ = { tools: [{ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { max_results: 5, label_ids: ["INBOX"] } }],
               thought: "Fetch the latest five", sync_response_to_workbench: false, session_id: "sess_1", current_step: "FETCH" };
// Thirteen app calls, the last an email with its body: an Allow covers all of them.
const MANY = { tools: [...Array.from({ length: 12 }, (_, i) => ({ tool_slug: "GMAIL_FETCH_EMAILS", arguments: { query: `mailbox-${i + 1}` } })),
                       { tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "ana@example.com", subject: "Lunch", body: "See you at noon by the river" } }],
               session_id: "sess_2", thought: "Look, then reply" };
const LOGO = "data:image/svg+xml;base64," + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>').toString("base64");

test("each app call in plain words, the plugin DGC calls named last, and only for Composio's multi-execute", () => {
  assert.deepEqual(calls.describe("COMPOSIO_MULTI_EXECUTE_TOOL", READ).map((c) => c.line),
                   ["Gmail · Fetch emails · 5 from Inbox · through Composio"]);
  assert.deepEqual(calls.describe("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", {
    tools: [{ tool_slug: "GOOGLECALENDAR_FIND_EVENT", arguments: { calendar_id: "primary", max_results: 10 } },
            { tool_slug: "NOTION_SEARCH_NOTION_PAGE", arguments: { query: "Reading list" } },
            { tool_slug: "GMAIL_SEND_EMAIL", arguments: { recipient_email: "ana@example.com", subject: "Lunch", body: "Hi" } },
            { tool_slug: "ACME_DO_THING", arguments: { color: "blue" } }] }).map((c) => c.line),
  ["Google Calendar · Find event · 10 from Primary · through Composio", "Notion · Search page · “Reading list” · through Composio",
   "Gmail · Send email · to ana@example.com · “Lunch” · through Composio", "Acme · Do thing · color blue · through Composio"]);
  // A line is a summary: what the email says is in what it sends, one click away (Inputs as sent), plumbing left out.
  const sent = JSON.parse(calls.sent("mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", MANY));
  assert.equal(sent.tools[12].arguments.body, "See you at noon by the river");
  assert.deepEqual(Object.keys(sent), ["tools"], "no plumbing in what it sends, as the card shows it");
  assert.equal(calls.describe("create_event", { title: "x" }), null, "any other tool: as it was");
  assert.equal(calls.describe("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [] }), null);
  assert.deepEqual(calls.shownInputs("COMPOSIO_SEARCH_TOOLS", { queries: ["x"], session_id: "s", thought: "t", current_step_metric: "m" }),
                   { queries: ["x"] }, "Composio's plumbing left out of what a card lists");
});

test("a call that sends shows every input it sends, in full and without plumbing; a read keeps them one click away", () => {
  const [fetch, send] = calls.describe("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [READ.tools[0],
    { tool_slug: "GMAIL_SEND_EMAIL", account: "ca_1", arguments: { recipient_email: "ana@example.com", subject: "Lunch",
      body: "See you at noon", session_id: "s", current_step: "X", cc: ["bo@example.com"] } }] });
  assert.deepEqual([fetch.read, fetch.fields], [true, []]);
  assert.deepEqual([send.read, send.fields], [false, [["recipient_email", "ana@example.com"], ["subject", "Lunch"],
    ["body", "See you at noon"], ["cc", '["bo@example.com"]']]]);
  assert.equal(calls.reads("COMPOSIO_MULTI_EXECUTE_TOOL", READ), true);
  assert.equal(calls.reads("COMPOSIO_MULTI_EXECUTE_TOOL", MANY), false, "one send in a batch: not a read");
  for (const slug of ["GMAIL_SEND_EMAIL", "GMAIL_DELETE_MESSAGE", "GOOGLECALENDAR_CREATE_EVENT", "SLACK_POST_MESSAGE", "ACME_DO_THING"]) {
    assert.equal(calls.describe("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: slug, arguments: { x: 1 } }] })[0].read, false, slug);
  }
  for (const slug of ["GMAIL_FETCH_EMAILS", "GOOGLEDRIVE_LIST_FILES", "NOTION_SEARCH_NOTION_PAGE", "GOOGLECALENDAR_FIND_EVENT", "GMAIL_GET_PROFILE"]) {
    assert.equal(calls.describe("COMPOSIO_MULTI_EXECUTE_TOOL", { tools: [{ tool_slug: slug, arguments: {} }] })[0].read, true, slug);
  }
});

test("an Allow lists every action it covers: thirteen app calls are thirteen lines", () => {
  const lines = calls.describe("COMPOSIO_MULTI_EXECUTE_TOOL", MANY).map((c) => c.line);
  assert.equal(lines.length, 13);
  assert.equal(lines[11], "Gmail · Fetch emails · “mailbox-12” · through Composio");
  assert.equal(lines[12], "Gmail · Send email · to ana@example.com · “Lunch” · through Composio");
});

test("a Pip's Allow card: Composio's logo when the page has it, else its letter, and the app calls in plain words", async () => {
  const code = (await build({ entryPoints: [join(root, "src/pipPlugins.js")], bundle: true, write: false, platform: "node",
                              format: "cjs", loader: { ".css": "empty" } })).outputFiles[0].text;
  const m = { exports: {} };
  new Function("module", "exports", "require", code)(m, m.exports, require);
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const draft = { id: "conndraft_" + "3".repeat(32), payload: { action: { server: "composio", call: { tool: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: READ } } } };
  const owner = m.exports.installedForServer([{ plugin: "composio", name: "Composio", money: false, servers: ["composio"] }], "composio");
  assert.deepEqual(owner, { plugin: "composio", name: "Composio", money: false });
  const plain = m.exports.pluginActionMarkup(draft, owner, { esc });
  assert.match(plain, /<span class="app-link-mark" aria-hidden="true" data-plugin-mark="composio">C<\/span>/);
  assert.match(plain, /<strong>Do this in Composio\?<\/strong>/);
  assert.match(plain, /<li>Gmail · Fetch emails · 5 from Inbox · through Composio<\/li>/);
  for (const plumbing of ["session_id", "sess_1", "sync_response_to_workbench", "current_step"]) assert.equal(plain.includes(plumbing), false, plumbing);
  const withLogo = m.exports.pluginActionMarkup(draft, owner, { esc, logo: (id) => (id === "composio" ? LOGO : "") });
  assert.match(withLogo, new RegExp(`<span class="app-link-mark has-logo" aria-hidden="true" data-plugin-mark="composio"><img alt="" src="${LOGO.replace(/[+/]/g, "\\$&")}"></span>`));
  const editing = m.exports.pluginActionMarkup(draft, owner, { esc, edit: { values: m.exports.argumentValues(READ) } });
  assert.match(editing, /session_id/, "Edit still edits every real input");
  // Every action it covers, and what it sends in full one click away (no Edit needed).
  const many = m.exports.pluginActionMarkup({ ...draft, payload: { action: { server: "composio", call: { tool: "COMPOSIO_MULTI_EXECUTE_TOOL", arguments: MANY } } } }, owner, { esc });
  assert.equal((many.match(/<li>/g) || []).length, 13);
  assert.match(many, /<li>Gmail · Send email · to ana@example\.com · “Lunch” · through Composio<dl class="allow-meta"><dt>recipient_email<\/dt><dd>ana@example\.com<\/dd><dt>subject<\/dt><dd>Lunch<\/dd><dt>body<\/dt><dd>See you at noon by the river<\/dd><\/dl><\/li>/,
               "the email it sends, in sight before Allow");
  assert.match(many, /<details class="allow-sent"><summary>Inputs as sent<\/summary><pre>[^<]*See you at noon by the river[^<]*<\/pre><\/details>/);
  assert.equal(many.includes("sess_2"), false, "no plumbing");
  // Any other plugin tool lists every input in full, a long letter too; and all of it as sent one click away.
  const letter = "Dear Ana, " + "the plan is ".repeat(60) + "the end.";
  const other = m.exports.pluginActionMarkup({ ...draft, payload: { action: { server: "mail", call: { tool: "send_email", arguments: { to: "ana@example.com", body: letter } } } } },
                                             { plugin: "mail", name: "Mail", money: false }, { esc });
  assert.ok(other.includes(`<dd>${letter}</dd>`), "the whole letter is in sight before Allow, not cut at 400 characters");
});

let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
before(async () => { if (!chromium) return; try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; } });
after(async () => { await browser?.close(); });

test("Work's Allow card for a plugin's tool wears the plugin's logo where the shield is, in both themes", async (t) => {
  if (!browser) {
    if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("DGC_REQUIRE_CHROMIUM=1: Chromium could not start");
    t.skip("Chromium could not start"); return;
  }
  for (const theme of ["dark-modern", "light-modern"]) {
    const { html, mainJs, markdownJs } = panelHtml();
    const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    try {
      await page.setContent(html, { waitUntil: "load" });
      await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES[theme]} }` });
      await page.evaluate(([pc, mjs, mdjs]) => {
        window.__postedAll = [];
        window.acquireVsCodeApi = () => ({ postMessage(m) { window.__postedAll.push(m); }, getState: () => undefined, setState() {} });
        eval(pc); eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;"); eval(mjs);
      }, [readFileSync(join(root, "media/pluginCalls.js"), "utf8"), mainJs, markdownJs]);
      const send = (event) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), event);
      await send({ type: "ready", version: "0.51.0", protocol_version: 14, capabilities: {}, model: "m", mode: "default", think: "off",
        base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
        context_size: 65536, session_id: "s1" });
      await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
      await send({ type: "plugin_catalog", items: [{ name: "composio", logo: LOGO }] });
      await send({ type: "turn_start", turn_id: "t1", prompt: "Summarise my mail" });
      await send({ type: "permission_request", id: "req-c", name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", args: READ,
                   summary: "COMPOSIO_MULTI_EXECUTE_TOOL", suggested_rule: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL" });
      await send({ type: "permission_request", id: "req-b", name: "bash", args: { command: "ls" }, command: "ls", summary: "ls" });
      const card = (id) => page.locator(`.card[data-request-id="${id}"]`);
      assert.equal(await card("req-c").locator(".q img.plugin-logo").getAttribute("src"), LOGO);
      // Its backdrop follows the logo's own colours: a dark logo on a light tile (a white one, Composio's, on a dark one).
      await page.waitForFunction(() => document.querySelector('.q .perm-logo')?.className.includes("logo-on"));
      assert.match(await card("req-c").locator(".q .perm-logo").getAttribute("class"), /logo-on-light/);
      assert.equal(await card("req-c").locator(".q").textContent(), "Do this in Composio?");
      assert.deepEqual(await card("req-c").locator(".perm-calls li").allTextContents(), ["Gmail · Fetch emails · 5 from Inbox · through Composio"]);
      assert.equal((await card("req-c").textContent()).includes("sess_1"), false, "no plumbing");
      assert.equal(await card("req-b").locator('.q [data-icon="shield"]').count(), 1, "any other step keeps the shield");
      // Every action it covers, and what it sends in full one click away.
      await send({ type: "permission_request", id: "req-m", name: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL", args: MANY,
                   summary: "COMPOSIO_MULTI_EXECUTE_TOOL", suggested_rule: "mcp__composio__COMPOSIO_MULTI_EXECUTE_TOOL" });
      assert.equal(await card("req-m").locator(".perm-calls li").count(), 13);
      assert.equal(await card("req-m").locator(".perm-calls li").nth(12).locator("dd", { hasText: "See you at noon by the river" }).isVisible(), true,
                   "the email it sends, in sight before Allow");
      assert.equal(await card("req-m").locator(".perm-calls li").first().locator("dl").count(), 0, "a read's inputs stay one click away");
      assert.equal(await card("req-m").locator(".perm-brief > summary").textContent(), "Inputs as sent");
      assert.equal(await card("req-m").locator(".perm-brief").getAttribute("open"), null, "closed until clicked");
      assert.match(await card("req-m").locator(".perm-brief pre").textContent(), /See you at noon by the river/);
      assert.equal((await card("req-m").textContent()).includes("sess_2"), false, "no plumbing");
      // A plugin whose logo the page hasn't had yet: the host is asked, and its answer replaces the shield.
      await send({ type: "permission_request", id: "req-d", name: "mcp__airtable__create_record", args: { table: "Plans" }, summary: "create_record" });
      const posted = await page.evaluate(() => (window.__postedAll || []).filter((m) => m.type === "pluginLogos"));
      assert.deepEqual(posted.map((m) => m.plugins), [["airtable"]]);
      assert.equal(await card("req-d").locator('.q [data-logo-for="airtable"] [data-icon="shield"]').count(), 1);
      await page.evaluate((src) => window.dispatchEvent(new MessageEvent("message", { data: { type: "pluginLogos", logos: { airtable: src } } })), LOGO);
      assert.equal(await card("req-d").locator(".q .perm-logo img.plugin-logo").getAttribute("src"), LOGO);
      assert.equal(await card("req-c").locator('.q [data-icon="shield"]').count(), 0);
      assert.deepEqual(errors, []);
    } finally { await page.close(); }
  }
});

test("a logo drawn light (Composio's white mark) gets a dark tile, any other a light one", async (t) => {
  if (!browser) { t.skip("Chromium could not start"); return; }
  const page = await browser.newPage();
  try {
    await page.setContent("<body></body>");
    await page.addScriptTag({ content: readFileSync(join(root, "media/pluginCalls.js"), "utf8") });
    const composio = "data:image/svg+xml;base64," + readFileSync(join(root, "media/plugin-logos/composio.svg")).toString("base64");
    const classes = await page.evaluate(async ([white, dark]) => {
      const out = [];
      for (const src of [white, dark]) {
        const mark = document.createElement("span"), img = document.createElement("img");
        img.src = src; mark.append(img); document.body.append(mark);
        globalThis.DgcPluginCalls.backdrop(img, mark);
        await new Promise((r) => { const check = () => (mark.className ? r() : setTimeout(check, 20)); check(); });
        out.push(mark.className);
      }
      return out;
    }, [composio, LOGO]);
    assert.deepEqual(classes, ["logo-on-dark", "logo-on-light"]);
  } finally { await page.close(); }
});


// Work's Allow card for a plugin's own tool cut every input at 200 characters ("…thin the carrots to five centimetres
// once the…"), and drew a read's inputs the same way. It reads them as ChatDGC and a Pip's chat do now: a call that
// sends or changes something shows every input it sends, in full and with no click; a read keeps them one click away.
const LONG = "Sow the carrots thinly in rows thirty centimetres apart, water them in, and cover the row with fleece "
  + "against carrot fly. Keep the soil moist until the seedlings show, then thin the carrots to five centimetres once the "
  + "first true leaves open, firming the soil back around the ones that stay. Water in dry spells, weed by hand, and lift "
  + "them from midsummer, the biggest first. Store the rest in damp sand.";
test("a plugin's own tool: a read by its verb, and a change shows every input in full", () => {
  assert.ok(LONG.length > 400);
  assert.deepEqual(calls.tool("mcp__notes__save_note", { title: "Carrots", body: LONG, tags: ["veg", "spring"], pinned: true }),
    { read: false, fields: [["title", "Carrots"], ["body", LONG], ["tags", '["veg","spring"]'], ["pinned", "true"]] });
  for (const name of ["mcp__notes__find_notes", "mcp__example__get-time", "mcp__drive__list_files", "search", "mcp__x__read-file"])
    assert.deepEqual(calls.tool(name, { query: "seed", limit: 3 }), { read: true, fields: [] }, name);
  for (const name of ["mcp__notes__save_note", "mcp__example__convert_time", "mcp__mail__send", "mcp__x__forget_notes", "mcp__x__getaway"])
    assert.equal(calls.tool(name, { a: 1 }).read, false, name);
});

test("Work's Allow card for a plugin's tool shows a change's every input in full, and a read's one click away", async (t) => {
  if (!browser) {
    if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail("DGC_REQUIRE_CHROMIUM=1: Chromium could not start");
    t.skip("Chromium could not start"); return;
  }
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 520, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  try {
    await page.setContent(html, { waitUntil: "load" });
    await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
    await page.evaluate(([pc, mjs, mdjs]) => {
      window.acquireVsCodeApi = () => ({ postMessage() {}, getState: () => undefined, setState() {} });
      eval(pc); eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;"); eval(mjs);
    }, [readFileSync(join(root, "media/pluginCalls.js"), "utf8"), mainJs, markdownJs]);
    const send = (event) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), event);
    await send({ type: "ready", version: "0.51.0", protocol_version: 14, capabilities: { plugin_names: { notes: "Notes (test)" } }, model: "m",
      mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [],
      goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
    await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
    await send({ type: "turn_start", turn_id: "t1", prompt: "Save a note about carrots" });
    const ask = (id, name, args) => send({ type: "permission_request", id, call_id: id, name, args, summary: "", suggested_rule: name,
      choices: ["once", "always", "deny"] });
    await ask("req-w", "mcp__notes__save_note", { title: "Carrots", body: LONG, tags: ["veg"] });
    await ask("req-r", "mcp__notes__find_notes", { query: "seed", limit: 3 });
    await ask("req-n", "mcp__notes__get-time", {});
    const card = (id) => page.locator(`.card[data-request-id="${id}"]`);
    const write = card("req-w");
    assert.equal((await write.locator(".q").innerText()).trim(), "Use Save note from Notes (test)?");
    assert.deepEqual(await write.locator(".perm-inputs dt").allInnerTexts(), ["title", "body", "tags"]);
    assert.deepEqual(await write.locator(".perm-inputs dd").allTextContents(), ["Carrots", LONG, '["veg"]'], "every input, in full");
    assert.equal(await write.locator(".perm-inputs dd").nth(1).isVisible(), true, "in sight, with no click");
    assert.equal(await write.locator(".perm-brief").getAttribute("open"), null, "Inputs as sent stays closed");
    if (process.env.DGC_SHOTS) await write.screenshot({ path: `${process.env.DGC_SHOTS}/work-plugin-write-card.png` });
    const read = card("req-r");
    assert.equal((await read.locator(".q").innerText()).trim(), "Use Find notes from Notes (test)?");
    assert.equal(await read.locator(".perm-inputs").count(), 0, "a read's inputs are not drawn in sight");
    assert.equal(await read.locator(".perm-brief > summary").textContent(), "Inputs as sent");
    assert.equal(await read.locator(".perm-brief pre").isVisible(), false, "one click away");
    await read.locator(".perm-brief > summary").click();
    assert.deepEqual(JSON.parse(await read.locator(".perm-brief pre").textContent()), { query: "seed", limit: 3 });
    if (process.env.DGC_SHOTS) await read.screenshot({ path: `${process.env.DGC_SHOTS}/work-plugin-read-card.png` });
    assert.equal((await card("req-n").locator(".perm-facts").innerText()).trim(), "No inputs.");
    assert.deepEqual(errors, []);
  } finally { await page.close(); }
});
