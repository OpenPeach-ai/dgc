// A Pip fix's agent shows the brief its fixer was given as its Prompt. Reported on 0.51.0's release candidate: opening
// "Fix what GST watchdog found" in the agent map said "This agent's prompt was not kept in the
// chat.", because a fix is started by its report's Fix and not by a task call, the only place the map read a prompt
// from. The fix's record carries the brief (pip_fix, pip_fixes, a replayed card's report.fix), live and after a reload.
// The real panel in Chromium (setContent only; no port is opened). DGC_REQUIRE_CHROMIUM=1 turns a missing browser
// into a failure instead of a skip.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { openMapScene } from "./support/agent-map-scene.mjs";

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

const RUN = "run_" + "a".repeat(32), PIP = "pip_" + "b".repeat(32), FIX = "fix_" + "c".repeat(32), AGENT = "sub-00000000fa11";
const BRIEF = "Fix what Pip “GST watchdog” found (run " + RUN + "), in this copy of the project.\n\n"
  + "What it found:\n1. [high] invoice_total keeps only the last line (billing.py:11)\n   Evidence: subtotal = line_total(price, quantity)\n"
  + "Check each finding against the code first. Fix the real ones; leave one that is not real alone and say why.";
const REPORT = { run_id: RUN, pip_id: PIP, name: "GST watchdog", pip_type: "scout", kind: "audit",
  outcome: "findings", finished_at: "2026-11-03T13:00:00.000Z", earlier: 0, total: 1, counts: { high: 1 },
  findings: [{ title: "invoice_total keeps only the last line", severity: "high", path: "billing.py", line: 11 }] };
const record = (fields = {}) => ({ fix_id: FIX, run_id: RUN, pip_id: PIP, name: REPORT.name, pip_type: "scout", agent_id: AGENT,
  created_at: Date.now() / 1000 - 20, state: "running", started_at: Date.now() / 1000 - 10, prompt: BRIEF, ...fields });
const started = () => ({ type: "agent_started", id: AGENT, parent_id: null, call_id: null,
  description: `Fix what ${REPORT.name} found`, depth: 1, state: "running", started_at: Date.now() / 1000 - 10,
  isolated: true, parallel: false, background: true });

// The fix's agent in the map: its card's Prompt, then its transcript's first message.
async function promptShown(page) {
  await page.click("#agents-pill");
  await page.waitForTimeout(150);
  await page.click(`#agent-map .am-row[data-am-key="agent:${AGENT}"]`);
  await page.waitForTimeout(150);
  const card = await page.evaluate(() => {
    const fold = document.querySelector("#agent-card-body details.am-fold");
    return { summary: fold?.querySelector("summary")?.textContent || "", text: fold?.querySelector("pre")?.textContent || "",
      quiet: !!fold?.querySelector("pre.am-quiet") };
  });
  await page.locator("#agent-card-body button", { hasText: "Open transcript" }).click();
  await page.waitForTimeout(150);
  const transcript = await page.evaluate(() => {
    const first = document.getElementById("agent-transcript-log").firstElementChild;
    return { agentPrompt: first?.classList.contains("agent-prompt") || false, text: first?.querySelector(".bubble")?.textContent || "",
      role: first?.querySelector(".role")?.textContent || "", note: first?.classList.contains("sys") ? first.textContent : "" };
  });
  return { card, transcript };
}

test("a Pip fix's agent shows its fixer's brief as its Prompt, in the map's card and its transcript", async (t) => {
  if (skipOrFail(t)) return;
  const { page, send, errors } = await openMapScene(browser, { width: 900, open: false,
    capabilities: { pip_reports: 1, pip_fix: 1 } });
  try {
    await send({ type: "pip_report", report: REPORT });
    await send(started());
    await send({ type: "pip_fix", fix: record(), request_id: "pip-fix-1" });
    const shown = await promptShown(page);
    assert.deepEqual(shown.card, { summary: "Prompt", text: BRIEF, quiet: false }, "the brief, not 'not kept in the chat'");
    assert.deepEqual(shown.transcript, { agentPrompt: true, text: BRIEF, role: "Ask DGC to fix", note: "" });
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});

test("after a window reload the fix's agent still shows its brief, from the fixes the chat lists and from its replayed card", async (t) => {
  if (skipOrFail(t)) return;
  for (const path of ["pip_fixes", "report.fix"]) {
    const { page, send, errors } = await openMapScene(browser, { width: 900, open: false,
      capabilities: { pip_reports: 1, pip_fix: 1 } });
    try {
      if (path === "report.fix") await send({ type: "pip_report", report: { ...REPORT, fix: record({ state: "applied" }) } });
      else {
        await send({ type: "pip_report", report: REPORT });
        await send({ type: "pip_fixes", items: [record({ state: "applied" })], request_id: "pip-fixes-1" });
      }
      await send(started());
      await send({ type: "agent_ended", id: AGENT, state: "finished", duration_ms: 11000, tool_calls: 3, message: "Fixed the total." });
      const shown = await promptShown(page);
      assert.equal(shown.card.text, BRIEF, path);
      assert.equal(shown.transcript.text, BRIEF, path);
      assert.deepEqual(errors, [], path);
    } finally {
      await page.close();
    }
  }
});

test("an agent with no prompt anywhere still says so", async (t) => {
  if (skipOrFail(t)) return;
  const { page, send, errors } = await openMapScene(browser, { width: 900, open: false,
    capabilities: { pip_reports: 1, pip_fix: 1 } });
  try {
    await send(started());           // no fix record for it: nothing to show
    const shown = await promptShown(page);
    assert.equal(shown.card.text, "This agent's prompt was not kept in the chat.");
    assert.equal(shown.card.quiet, true);
    assert.match(shown.transcript.note, /prompt was not kept/);
    assert.deepEqual(errors, []);
  } finally {
    await page.close();
  }
});
