// Render (26 Nov): a turn's list stopped on the provider's limit and carried on by "continue": the earlier card says so,
// with Show it, its open steps stepped back. Dark and light, 440 px. Pictures into argv[2].
import { chromium } from "@playwright/test";
import { openWorkTab } from "./support/work-tab-scene.mjs";
const out = process.argv[2];
const PLAN = [{ content: "Customer-copy builder + review variant", status: "done" }, { content: "report_jobs builds both copies; migration 0288", status: "in_progress" },
  { content: "Frontend: Owner copy / Customer copy buttons", status: "pending" }, { content: "Tests + suites green; deploy", status: "pending" }];
const CARRIED = [{ content: "Customer-copy builder + review variant + jobs wiring + migration", status: "done" }, { content: "Frontend buttons; typecheck clean", status: "done" },
  { content: "Deploy backend + frontend; live-verify a customer copy", status: "in_progress" }, { content: "Commit + report", status: "pending" }];
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
for (const theme of ["dark-modern", "light-modern"]) {
  const x = await openWorkTab(browser, { width: 440, height: 900, theme });
  const ev = (e) => x.send({ type: "event", event: e });
  await x.send({ type: "session_ready", sessionId: "s1" });
  await ev({ type: "ready", model: "m", mode: "default", think: "off", base_url: "x", capabilities: { agents: true }, goal: { text: "", status: "none" } });
  let n = 0; const plan = async (todos) => { const id = "td" + (++n); await ev({ type: "tool_call", call_id: id, name: "todo", args: { todos } }); await ev({ type: "todos", todos }); await ev({ type: "tool_result", call_id: id, name: "todo", output: "ok", is_error: false, is_diff: false }); };
  await ev({ type: "turn_start", turn_id: "t1", prompt: "Make a Customer Copy for every report", kind: "prompt" }); await plan(PLAN);
  await ev({ type: "error", message: "HTTP 429", cause: { kind: "rate_limited", summary: "HTTP 429 Too Many Requests", http_status: 429, attempts: 3 } });
  await ev({ type: "turn_end", turn_id: "t1", reason: "error" });
  await ev({ type: "turn_start", turn_id: "t2", prompt: "continue", kind: "prompt" }); await plan(CARRIED);
  await x.page.waitForTimeout(600);
  const card = x.page.locator("#log .todos-card").first(); await card.scrollIntoViewIfNeeded();
  await x.page.screenshot({ path: `${out}/carried-${theme}.png`, fullPage: false });
  await x.page.close?.();
}
await browser.close(); console.log("done");
