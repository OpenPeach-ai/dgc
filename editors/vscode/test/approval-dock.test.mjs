// The approval dock (ui-04-dock-approvals, asked 10 Nov): a waiting approval sits just above the prompt box, as Claude
// Code's and Codex's do (Codex: one current request in its bottom pane, the rest queued), one at a time with "1 of 3";
// answered, it goes back to where its step is in the chat as its one quiet line. media/main.js in Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";

let chromium, browser;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  if (browser) return false;
  const reason = chromium ? "Chromium could not start" : "playwright is not installed";
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};

async function scene(theme, width = 520, ids = ["a", "b"]) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const send = (event) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), event);
  await send({ type: "ready", version: "0.40.0", protocol_version: 14, capabilities: {}, model: "m", mode: "default", think: "off",
    base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
    context_size: 65536, session_id: "s1" });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
  await send({ type: "turn_start", turn_id: "t1", prompt: "Run the tests" });
  for (const id of ids) {
    await send({ type: "permission_request", id: `req-${id}`, name: "bash", args: { command: "ls -la src" }, command: "ls -la src",
      summary: "ls -la src", suggested_rule: "Bash(ls:*)" });
  }
  const card = (id) => page.locator(`.card[data-request-id="req-${id}"]`);
  const posted = () => page.evaluate(() => window.__posted.filter((m) => m.type === "permission_response").map((m) => [m.id, m.decision, m.reason ?? null]));
  return { page, errors, card, posted, send };
}


const where = (s, id) => s.card(id).evaluate((n) => n.closest("#approval-dock") ? "dock" : n.closest("#log") ? "chat" : "elsewhere");
const dockFacts = (s) => s.page.evaluate(() => {
  const dock = document.getElementById("approval-dock"), box = document.getElementById("cbox");
  const shown = [...dock.querySelectorAll(":scope > .card")].filter((c) => !c.hidden);
  return { visible: !dock.hidden && dock.getClientRects().length > 0, above: dock.getBoundingClientRect().bottom <= box.getBoundingClientRect().top + 1,
    shown: shown.map((c) => c.dataset.requestId), count: shown[0]?.querySelector(".perm-count")?.textContent || "" };
});

test("a waiting approval sits just above the prompt box; answered, its one line goes back to its step in the chat", async (t) => {
  if (skipOrFail(t)) return;
  const s = await scene("dark-modern", 520, ["a"]);
  try {
    assert.equal(await where(s, "a"), "dock");
    const open = await dockFacts(s);
    assert.ok(open.visible && open.above, `just above the box: ${JSON.stringify(open)}`);
    await s.card("a").locator('button[data-d="once"]').click();
    assert.equal(await where(s, "a"), "chat", "the answer stays where the step is");
    assert.match(await s.card("a").innerText(), /Allowed once/);
    assert.equal((await dockFacts(s)).visible, false, "nothing waits: no dock");
    assert.deepEqual(await s.posted(), [["req-a", "once", null]]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("several at once: one at a time, 1 of 3, then 2 of 3", async (t) => {
  if (skipOrFail(t)) return;
  const s = await scene("light-modern", 520, ["a", "b", "c"]);
  try {
    let d = await dockFacts(s);
    assert.deepEqual([d.shown, d.count], [["req-a"], "1 of 3"]);
    await s.card("a").locator('button[data-d="once"]').click();
    d = await dockFacts(s);
    assert.deepEqual([d.shown, d.count], [["req-b"], "2 of 3"]);
    await s.card("b").locator('button[data-d="deny"]').click();
    await s.card("b").locator("button[data-no-note]").click();
    d = await dockFacts(s);
    assert.deepEqual([d.shown, d.count], [["req-c"], "3 of 3"]);
    assert.deepEqual(await Promise.all(["a", "b"].map((id) => where(s, id))), ["chat", "chat"]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("answered elsewhere, or its backend gone: it leaves the dock for its place in the chat", async (t) => {
  if (skipOrFail(t)) return;
  const s = await scene("dark-modern", 520, ["a", "b"]);
  try {
    await s.send({ type: "permission_resolved", id: "req-a", decision: "no", message: "Denied by a rule" });
    assert.equal(await where(s, "a"), "chat");
    assert.deepEqual((await dockFacts(s)).shown, ["req-b"]);
    await s.send({ type: "ready", version: "0.40.0", protocol_version: 14, capabilities: {}, model: "m", mode: "default", think: "off",
      base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
      context_size: 65536, session_id: "s1" });
    assert.equal(await where(s, "b"), "chat", "a request from a backend that restarted can't be answered: not in the dock");
    assert.equal((await dockFacts(s)).visible, false);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("the box stays yours: an approval arriving leaves your typing alone; Show from the image viewer lands on Allow once", async (t) => {
  if (skipOrFail(t)) return;
  const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const s = await scene("dark-modern", 520, []);
  try {
    await s.send({ type: "ready", version: "0.40.0", protocol_version: 14, capabilities: { image_views: true }, model: "m", mode: "default",
      think: "off", base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [],
      goal: { text: "", status: "none" }, context_size: 65536, session_id: "s1" });
    await s.send({ type: "turn_start", turn_id: "t2", prompt: "Look at the page" });
    await s.page.locator("#input").click();
    await s.page.keyboard.type("and then");
    await s.send({ type: "permission_request", id: "req-a", name: "bash", args: { command: "ls" }, command: "ls", summary: "ls", suggested_rule: "Bash(ls:*)" });
    assert.equal(await s.page.evaluate(() => document.activeElement?.id), "input", "the keyboard stays in the box");
    await s.page.keyboard.type(" more");
    assert.equal((await s.page.locator("#input").innerText()).trim(), "and then more");
    await s.send({ type: "tool_call", call_id: "c1", name: "browser", args: {}, summary: "browser" });
    await s.send({ type: "tool_result", call_id: "c1", name: "browser", output: "screenshot saved", is_error: false, is_diff: false });
    await s.send({ type: "tool_images", call_id: "c1", images: [PNG] });
    await s.page.evaluate(() => {
      const card = document.querySelector('.tool[data-call-id="c1"]');
      card.closest(".tool-group")?.setAttribute("open", "");
      card.querySelector(".tool-toggle")?.click();
      document.querySelector('.tool[data-call-id="c1"] .image-chip').click();
    });
    await s.page.waitForSelector("#image-viewer");
    await s.send({ type: "permission_request", id: "req-b", name: "bash", args: { command: "pwd" }, command: "pwd", summary: "pwd", suggested_rule: "Bash(pwd)" });
    await s.page.waitForSelector("#image-viewer .iv-notice:not([hidden])");
    await s.page.click("#image-viewer .iv-show");
    const focus = await s.page.evaluate(() => ({ d: document.activeElement?.dataset.d, card: document.activeElement?.closest(".card")?.dataset.requestId,
      docked: !!document.activeElement?.closest("#approval-dock") }));
    assert.deepEqual(focus, { d: "once", card: "req-a", docked: true }, "the one that asks now, on its filled button");
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});
