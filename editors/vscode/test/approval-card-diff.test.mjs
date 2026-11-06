// Collapsing the diff on an Allow card never answers it. Reported on the 0.51.0 release candidate: the collapse arrow
// of the "changed file" diff on a Pip fix's Allow card denied the call, and the chat then said "DGC command violated
// protocol v14: permission_response.decision is required". The card put its answer handler on every button in it, the
// diff's own toggle and open button included. Only the answer buttons answer; the diff's buttons keep their own jobs.
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

const DIFF = "--- a/billing.py\n+++ b/billing.py\n@@ -9,4 +9,4 @@\n def invoice_total(lines):\n     subtotal = 0\n"
  + "     for price, quantity in lines:\n-        subtotal = line_total(price, quantity)\n+        subtotal += line_total(price, quantity)\n";
const RUN = "run_" + "a".repeat(32), PIP = "pip_" + "b".repeat(32), FIX = "fix_" + "c".repeat(32), AGENT = "sub-0123456789ab";

async function scene(capabilities = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width: 480, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES["dark-modern"]} }` });
  await page.evaluate(() => document.body.classList.add("vscode-dark"));
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const send = (event) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), event);
  await send({ type: "ready", version: "0.51.0", protocol_version: 14, capabilities, model: "m", mode: "default", think: "off",
    base_url: "http://127.0.0.1:1/v1", workspace_trusted: true, commands: [], custom_commands: [], goal: { text: "", status: "none" },
    context_size: 65536, session_id: "s1" });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
  const posted = (type) => page.evaluate((t) => window.__posted.filter((m) => m.type === t), type);
  return { page, errors, send, posted };
}

// The diff's toggle and its open button, then the answer: on whichever card `card` names.
async function collapseThenAllow(s, card, id) {
  const diff = card.locator(".diff");
  const toggle = diff.locator(".diff-toggle");
  const state = () => card.evaluate((c) => ({
    open: c.querySelector(".diff").classList.contains("open"),
    expanded: c.querySelector(".diff-toggle").getAttribute("aria-expanded"),
    resolved: c.classList.contains("resolved"),
    answersEnabled: [...c.querySelectorAll(".btns button")].filter((b) => !b.disabled).map((b) => b.dataset.d),
  }));
  assert.deepEqual(await state(), { open: true, expanded: "true", resolved: false, answersEnabled: ["once", "always", "deny"] });

  await toggle.click();
  assert.deepEqual(await state(), { open: false, expanded: "false", resolved: false, answersEnabled: ["once", "always", "deny"] },
    "the arrow collapses the diff, and the card stays open and undecided");
  assert.deepEqual(await s.posted("permission_response"), [], "collapsing a diff answers nothing");
  await toggle.click();
  assert.equal((await state()).open, true, "and opens it again");

  await diff.locator(".open-file").click();
  assert.deepEqual((await s.posted("openFile")).map((m) => m.path), ["billing.py"], "the open button opens the file");
  assert.deepEqual(await s.posted("permission_response"), [], "opening the file answers nothing");
  assert.equal((await state()).resolved, false);

  await card.locator('button[data-d="once"]').click();
  assert.deepEqual((await s.posted("permission_response")).map((m) => [m.id, m.decision]), [[id, "once"]],
    "Allow once still answers, exactly once");
  assert.equal((await state()).resolved, true);
}

test("collapsing the diff on a Work chat's Allow card leaves it open and undecided; Allow once still answers once", async (t) => {
  if (skipOrFail(t)) return;
  const s = await scene();
  try {
    await s.send({ type: "turn_start", turn_id: "t1", prompt: "Fix the total" });
    await s.send({ type: "permission_request", id: "req-edit", name: "apply_patch", args: { path: "billing.py", patch: DIFF },
      diff: DIFF, summary: "billing.py", suggested_rule: "Edit(billing.py)" });
    await collapseThenAllow(s, s.page.locator('.card[data-request-id="req-edit"]'), "req-edit");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.page.close();
  }
});

test("collapsing the diff on a Pip fix's Allow card leaves it open and undecided; Allow once still answers once", async (t) => {
  if (skipOrFail(t)) return;
  const s = await scene({ pip_reports: 1, pip_fix: 1, agents: true, agent_control: true });
  try {
    const now = Date.now() / 1000;
    await s.send({ type: "pip_report", report: {
      run_id: RUN, pip_id: PIP, name: "GST watchdog", pip_type: "scout", kind: "audit", outcome: "findings",
      finished_at: "2026-11-03T13:00:00.000Z", earlier: 0, total: 1, counts: { high: 1 },
      findings: [{ title: "invoice_total keeps only the last line", severity: "high", path: "billing.py", line: 11 }] } });
    await s.send({ type: "agent_started", id: AGENT, parent_id: null, call_id: null, description: "Fix what GST watchdog found",
      depth: 1, state: "running", started_at: now, isolated: true, parallel: false, background: true });
    await s.send({ type: "pip_fix", fix: { fix_id: FIX, run_id: RUN, pip_id: PIP, name: "GST watchdog", pip_type: "scout",
      agent_id: AGENT, created_at: now - 30, state: "running", started_at: now - 5 } });
    await s.send({ type: "permission_request", id: "req-fix", call_id: `${AGENT}:c1`, name: "apply_patch",
      args: { path: "billing.py", patch: DIFF }, diff: DIFF, summary: "billing.py", suggested_rule: "Edit(billing.py)" });
    const card = s.page.locator('.pip-fix-ask .card[data-request-id="req-fix"]');
    assert.equal(await card.count(), 1, "asked on the fix's card");
    assert.match(await card.locator(".q").innerText(), /Run apply_patch/);
    await collapseThenAllow(s, card, "req-fix");
    assert.deepEqual(s.errors, []);
  } finally {
    await s.page.close();
  }
});
