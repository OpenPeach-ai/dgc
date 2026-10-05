// A Pip setup or change is approved by its permission card, like any tool call, so the card must
// say what is being created and what Allow does: the job in words, never its JSON.
// media/main.js in Chromium with a scripted event stream (setContent only; no port is opened).
// DGC_REQUIRE_CHROMIUM=1 turns a missing browser into a failure instead of a skip.
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
  const reason = chromium ? "Chromium could not start" : "playwright is not installed (npm ci at the repository root)";
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${reason}`);
  t.skip(reason);
  return true;
};

const setupArgs = {
  target_root: "/home/me/project", name: "Market brief", goal: "Before the open, brief me on news that moves my watchlist, with sources.",
  pip_type: "lens", work_kind: "personal_task", scope: "personal",
  schedule: { type: "cron", cron: "30 8 * * 1-5", timezone: "Asia/Kolkata" }, run_now: false,
  web_plan: { schema_version: 1, reads: [{ kind: "page", url: "https://example.com/markets" }, { kind: "search", query: "Infosys results" }] },
  request_key: "brief-1", reason: "The user asked for a weekday brief.",
};

async function scene(event) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 420, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES["dark-modern"] || Object.values(THEMES)[0]} }` });
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const send = (e) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), e);
  await send({ type: "ready", version: "0.48.0", protocol_version: 14, capabilities: {}, model: "m", mode: "default", think: "off",
    base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
    context_size: 65536, session_id: "s1" });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
  await send({ type: "turn_start", turn_id: "t1", prompt: "Make me a weekday market brief" });
  await send(event);
  return { page, errors, card: page.locator('.card[data-request-id="p1"]') };
}

test("a Pip setup's permission card shows the job and what Allow does, not JSON", async (t) => {
  if (skipOrFail(t)) return;
  const { page, errors, card } = await scene({ type: "permission_request", id: "p1", name: "pips_setup", args: setupArgs,
    summary: "Create Pip “Market brief” · lens, personal · weekdays at 08:30 (Asia/Kolkata) · reads 2 pages or searches",
    suggested_rule: "PipsSetup", choices: ["once", "always", "deny"] });
  const text = await card.innerText();
  assert.match(text, /Set up a Pip/);
  assert.doesNotMatch(text, /pips_setup/, "the tool's name is not the user's word for it");
  assert.match(text, /weekdays at 08:30 \(Asia\/Kolkata\)/);
  assert.match(text, /Market brief/);
  assert.match(text, /Before the open, brief me/);
  assert.match(text, /https:\/\/example\.com\/markets/);
  assert.match(text, /Search: Infosys results/);
  assert.match(text, /Allow creates this Pip and turns it on, with a daily limit of 200,000 tokens/);
  assert.equal(await card.locator("pre").count(), 0, "no raw JSON");
  assert.doesNotMatch(text, /request_key|target_root/);
  await card.locator('button[data-d="once"]').click();
  const posted = await page.evaluate(() => window.__posted.filter((m) => m.type === "permission_response"));
  assert.deepEqual(posted.map((m) => [m.id, m.decision]), [["p1", "once"]], "an ordinary permission answer");
  assert.deepEqual(errors, []);
  await page.close();
});

test("a change to an existing Pip lists exactly what changes", async (t) => {
  if (skipOrFail(t)) return;
  const { page, card } = await scene({ type: "permission_request", id: "p1", name: "pips_propose",
    args: { pip_id: "pip_" + "1".repeat(32), expected_version: 2, changes: { goal: "Inspect authorization checks." },
            reason: "The project now has authenticated routes.", request_key: "k" },
    summary: "Change a Pip: goal → Inspect authorization checks.", suggested_rule: "PipsPropose", choices: ["once", "always", "deny"] });
  const text = await card.innerText();
  assert.match(text, /goal\s*Inspect authorization checks\./);
  assert.match(text, /Allow applies this change to the Pip\./);
  assert.equal(await card.locator("pre").count(), 0);
  await page.close();
});

test("other tools keep their raw arguments", async (t) => {
  if (skipOrFail(t)) return;
  const { page, card } = await scene({ type: "permission_request", id: "p1", name: "web_fetch", args: { url: "https://example.com" },
    summary: "https://example.com", suggested_rule: "WebFetch", choices: ["once", "always", "deny"] });
  assert.equal(await card.locator("pre").count(), 1);
  await page.close();
});
