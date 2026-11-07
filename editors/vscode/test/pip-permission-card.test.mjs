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
  assert.match(text, /Allow creates this Pip and turns it on\./);
  assert.doesNotMatch(text, /daily limit/, "Pips have no daily limit");
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
  assert.match(text, /Goal\s*Inspect authorization checks\./);
  assert.match(text, /Allow applies this change to the Pip\./);
  assert.equal(await card.locator("pre").count(), 0);
  await page.close();
});

test("a Pip workflow review names each pinned Pip and never offers Always allow", async (t) => {
  if (skipOrFail(t)) return;
  const first = "pip_" + "1".repeat(32), second = "pip_" + "2".repeat(32);
  const { page, errors, card } = await scene({ type: "permission_request", id: "p1", name: "pips_workflow",
    args: { scope: "personal", name: "Morning to draft", pip_ids: [first, second],
      pip_names: ["Market research", "Blog writer"], tasks: ["Draft a sourced post."], mode: "reviewed",
      expected_pins: [{ pip_id: first, job_version: 1, lifecycle_revision: 0 },
        { pip_id: second, job_version: 1, lifecycle_revision: 0 }] },
    summary: "Create personal Pip workflow · 2 Pips", suggested_rule: "PipsWorkflow", choices: ["once", "deny"] });
  const text = await card.innerText();
  assert.match(text, /Start\s*Market research/);
  assert.match(text, /Step 2\s*Blog writer/);
  assert.match(text, /Handoff task\s*Draft a sourced post/);
  assert.match(text, /Review each handoff/);
  assert.doesNotMatch(text, /pip_[12]{32}|expected_pins/);
  assert.equal(await card.locator('button[data-d="always"]').count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});

test("a Pip's new model and context window read as words, never [object Object]", async (t) => {
  // Pips API 66: the main chat changes a Pip's model and window with pips_propose, and the Pips default with
  // pips_settings. Their cards said "model choice [object Object]" and "Run pips_settings".
  if (skipOrFail(t)) return;
  const change = await scene({ type: "permission_request", id: "p1", name: "pips_propose",
    args: { pip_id: "pip_" + "1".repeat(32), expected_version: 1, reason: "The user asked for a stronger model.", request_key: "k",
            changes: { model_choice: { mode: "model", model: "glm-5.3:cloud" }, context_window: 65536 } },
    summary: "Change Pip “Billing audit”: model → glm-5.3:cloud; context window → 64K tokens", suggested_rule: "PipsPropose",
    choices: ["once", "always", "deny"] });
  let text = await change.card.innerText();
  assert.match(text, /Change a Pip/);
  assert.match(text, /Billing audit/, "the line names the Pip");
  assert.match(text, /Model\s*glm-5\.3:cloud/);
  assert.match(text, /Context window\s*64K tokens/);
  assert.match(text, /starts no work, and what the Pip may do stays the same/);
  assert.doesNotMatch(text, /object Object|model_choice|context_window/);
  await change.page.close();
  const personal = await scene({ type: "permission_request", id: "p1", name: "pips_propose",
    args: { pip_id: "pip_" + "2".repeat(32), scope: "personal", expected_version: 3, reason: "Use my Claude plan.", request_key: "k",
            changes: { model_choice: { mode: "subscription", engine: "claude" } } },
    summary: "Change Pip “Inbox helper”: model → Claude Code (your subscription)", suggested_rule: "PipsPropose", choices: ["once", "always", "deny"] });
  assert.match(await personal.card.innerText(), /Model\s*Claude Code, on your own plan/);
  await personal.page.close();
  const settings = await scene({ type: "permission_request", id: "p1", name: "pips_settings",
    args: { default_model: "glm-5.3:cloud", reason: "Every Pip on GLM." }, summary: "Pips default model → glm-5.3:cloud",
    suggested_rule: "PipsSettings", choices: ["once", "always", "deny"] });
  text = await settings.card.innerText();
  assert.match(text, /Change the Pips default model/);
  assert.doesNotMatch(text, /pips_settings/);
  assert.match(text, /Model for Pips\s*glm-5\.3:cloud/);
  assert.match(text, /every Pip on Default uses it from its next run/);
  assert.equal(await settings.card.locator("pre").count(), 0);
  await settings.page.close();
  const setup = await scene({ type: "permission_request", id: "p1", name: "pips_setup",
    args: { ...setupArgs, model_choice: { mode: "model", model: "glm-5.3:cloud" }, context_window: 131072 },
    summary: "Create Pip “Market brief” · lens, personal · glm-5.3:cloud · 128K tokens window", suggested_rule: "PipsSetup",
    choices: ["once", "always", "deny"] });
  text = await setup.card.innerText();
  assert.match(text, /Model\s*glm-5\.3:cloud/);
  assert.match(text, /Context window\s*128K tokens/);
  await setup.page.close();
});

test("a Pip's own tools say what they do and to which Pip, never the call's JSON or its id", async (t) => {
  // Final check, 2026-11-07: a main DGC Allow card read "Run resume_pip {"pip_id":"pip_96…","expected_version":3,…}".
  if (skipOrFail(t)) return;
  const pip = "pip_" + "9".repeat(32), run = "run_" + "8".repeat(32);
  const base = { pip_id: pip, expected_version: 3, reason: "The user asked for it.", request_key: "k", pip_name: "Order Keeper" };
  const rows = [
    ["pause_pip", { ...base, expected_lifecycle_revision: 0 }, /Pause Order Keeper\?/, /waits until you resume it/],
    ["resume_pip", { ...base, expected_lifecycle_revision: 0 }, /Resume Order Keeper\?/, /can run again/],
    ["attach_pip_to_session", { ...base, expected_lifecycle_revision: 0 }, /Attach Order Keeper to this chat\?/, /no new tools/],
    ["run_pip_now", base, /Run Order Keeper now\?/, /comes back to this chat/],
    ["pips_adapt", { ...base, changes: { name: "Seed Keeper" } }, /Change Order Keeper\?/, /New name\s*Seed Keeper/],
    ["handoff_to_pip", { source_kind: "personal_result", scope: "personal", source_run_id: run, target_pip_id: pip, task: "Write it up", shared_text: "Peas are late", request_key: "k", pip_name: "Order Keeper" },
      /Hand this to Order Keeper\?/, /Task\s*Write it up[\s\S]*Shared\s*Peas are late[\s\S]*Nothing runs until you accept/],
    ["draft_pip_email", { scope: "personal", source_run_id: run, message: { recipient_email: "a@example.com", subject: "Peas", body: "They are late." }, request_key: "k", pip_name: "Order Keeper" },
      /Save this email as a draft\?/, /From\s*Order Keeper[\s\S]*To\s*a@example\.com[\s\S]*Message\s*They are late\.[\s\S]*Nothing is sent/],
    ["draft_pip_calendar_event", { scope: "personal", source_run_id: run, event: { summary: "Sow peas", start_datetime: "2026-11-08T09:00:00Z", end_datetime: "2026-11-08T10:00:00Z", timezone: "UTC", description: "" }, request_key: "k" },
      /Save this event as a draft\?/, /Event\s*Sow peas[\s\S]*When\s*2026-11-08T09:00:00Z to 2026-11-08T10:00:00Z \(UTC\)/],
    ["draft_pip_connector_action", { scope: "personal", source_run_id: run, action: { server: "zapier", connection_digest: "a", schema_digest: "b", call: { tool: "add_row", arguments: { sheet: "orders" } } }, request_key: "k" },
      /Save this action in zapier as a draft\?/, /Action\s*add_row[\s\S]*Nothing runs/],
  ];
  for (const [name, args, title, detail] of rows) {
    const { page, errors, card } = await scene({ type: "permission_request", id: "p1", name, args, summary: "Words", suggested_rule: `Pips(${pip})`, choices: ["once", "always", "deny"] });
    const text = await card.innerText();
    assert.match(text, title, name);
    assert.match(text, detail, name);
    assert.doesNotMatch(text, new RegExp(`${name}|expected_version|request_key|${pip}|${run}|\\{"`), `${name}: no call, no id, no JSON`);
    assert.deepEqual(errors, [], name);
    await card.locator('button[data-d="always"]').click();
    const receipt = await card.locator(".permission-receipt > summary").innerText();
    assert.match(receipt, /· Always allowed$/, `${name}: the receipt names no rule's Pip id`);
    const [answer] = await page.evaluate(() => window.__posted.filter((m) => m.type === "permission_response"));
    assert.equal(answer.rule, `Pips(${pip})`, `${name}: the rule still goes back as the card offered it`);
    await page.close();
  }
  const unnamed = await scene({ type: "permission_request", id: "p1", name: "resume_pip", args: { pip_id: pip, reason: "x" }, summary: "Resume a Pip", suggested_rule: "PipsResume", choices: ["once", "deny"] });
  const text = await unnamed.card.innerText();
  assert.match(text, /Resume this Pip\?/, "a name that can't be read never becomes its id");
  assert.doesNotMatch(text, new RegExp(pip));
  await unnamed.page.close();
});

test("other tools keep their raw arguments", async (t) => {
  if (skipOrFail(t)) return;
  const { page, card } = await scene({ type: "permission_request", id: "p1", name: "web_fetch", args: { url: "https://example.com" },
    summary: "https://example.com", suggested_rule: "WebFetch", choices: ["once", "always", "deny"] });
  assert.equal(await card.locator("pre").count(), 1);
  await page.close();
});
