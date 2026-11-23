// A Work chat on Claude Code or Codex with Dev Mode's "Work on a subscription uses DGC's tools" on: the turn is DGC's
// own, so a message sent while it runs steers it (Enter to steer) and DGC keeps the context window (a percentage, as on
// any model). Off, the CLI runs the turn whole: follow-ups queue, and the CLI manages its own window, as before. A save
// in Settings reaches the open chat at once (the host's devSubscriptionTools). Real webview script, in Chromium.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { THEMES, panelHtml } from "./support/options-scene.mjs";
import { messageQueueJs } from "./support/webview-dom.mjs";

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

async function openChat({ on, engine = "claude" }) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 700, height: 700 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; ${THEMES["dark-modern"]} }` });
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, messageQueueJs + "\n" + markdownJs]);
  const send = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const event = (e) => send({ type: "event", event: e });
  await send({ type: "session_ready", sessionId: "s1" });
  // What the backend says: steering_native follows the switch (dgc/headless.py), and the switch rides in capabilities.
  await event({ type: "ready", capabilities: { history_snapshot: true, live_steering: true, steering_native: on,
    dev_subscription_tools: { version: 1, set: on, on, engines: ["claude", "codex"] } },
    model: "claude", mode: "default", think: "off", commands: [], custom_commands: [], goal: { text: "", status: "none" },
    context_size: 200000, session_id: "s1" });
  await send({ type: "state", state: { model: "Claude Code", mode: "default", think: "off", subscriptionEngine: engine, goal: { text: "", status: "none", elapsed_seconds: 0 } } });
  await event({ type: "config", model: "m", mode: "default", think: "off", base_url: "http://localhost.invalid/v1", project_root: "/p", goal: {},
    subscription_engine: engine, subscription_engines: [{ key: engine, label: engine === "claude" ? "Claude Code" : "Codex" }] });
  await event({ type: "context", used: 50000, size: 200000, compact_threshold: 0.85, compact_at: 170000, input_tokens: 0, output_tokens: 0,
    cached_input_tokens: 0, reasoning_tokens: 0, requests: 1 });
  const settle = () => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => setTimeout(done, 100))));
  const look = () => page.evaluate(() => ({ hint: document.getElementById("followup-hint").textContent,
    meter: document.getElementById("ctx").textContent, meterTitle: document.getElementById("btn-ctx").title }));
  return { page, send, event, settle, look, errors };
}

test("on: a message while it works steers the turn, and DGC's window shows as a percentage", async (t) => {
  if (skipOrFail(t)) return;
  for (const engine of ["claude", "codex"]) {
    const c = await openChat({ on: true, engine });
    try {
      await c.event({ type: "turn_start", turn_id: "t1", prompt: "Add a test", kind: "prompt" });
      await c.settle();
      const seen = await c.look();
      assert.equal(seen.hint, "Enter to steer · Alt+Enter to queue", engine);
      assert.equal(seen.meter, "25%", `${engine}: DGC keeps the window`);
      assert.deepEqual(c.errors, []);
    } finally { await c.page.close(); }
  }
});

test("off: follow-ups queue and the CLI keeps its own window, as before", async (t) => {
  if (skipOrFail(t)) return;
  const c = await openChat({ on: false });
  try {
    await c.event({ type: "turn_start", turn_id: "t1", prompt: "Add a test", kind: "prompt" });
    await c.settle();
    const seen = await c.look();
    assert.equal(seen.hint, "Follow-ups queue for the next turn");
    assert.equal(seen.meter, "");
    assert.match(seen.meterTitle, /manages its own context window/);
  } finally { await c.page.close(); }
});

test("a save in Settings reaches the open chat at once, both ways", async (t) => {
  if (skipOrFail(t)) return;
  const c = await openChat({ on: false });
  try {
    await c.event({ type: "turn_start", turn_id: "t1", prompt: "Add a test", kind: "prompt" });
    await c.send({ type: "devSubscriptionTools", on: true });
    await c.settle();
    assert.equal((await c.look()).hint, "Enter to steer · Alt+Enter to queue");
    assert.equal((await c.look()).meter, "25%");
    await c.send({ type: "devSubscriptionTools", on: false });
    await c.settle();
    assert.equal((await c.look()).hint, "Follow-ups queue for the next turn");
    assert.deepEqual(c.errors, []);
  } finally { await c.page.close(); }
});
