// A Project Pip's chat and a Personal Pip's, drawn by the real client and its CSS in real Chromium (pip-chat-parity, 24
// Oct). The chat's look was scoped to the Personal page's shell (.simple-pips), so a Project Pip's chat, in its own page,
// had none of it: jsdom can't see that, so this compares what Chromium paints for the same pieces of both.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

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
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });

const bundled = await build({ entryPoints: [new URL("../src/pipsClient.js", import.meta.url).pathname], bundle: true, write: false,
  format: "iife", outdir: "out", platform: "browser", loader: { ".png": "dataurl", ".svg": "dataurl", ".webp": "dataurl" } });
const js = bundled.outputFiles.find((f) => f.path.endsWith(".js")).text;
const css = bundled.outputFiles.filter((f) => f.path.endsWith(".css")).map((f) => f.text).join("\n");
const PIP = "pip_" + "g".repeat(32);

// One workspace, Personal or a project, with one Pip and one exchange in its chat.
const hostFor = (kind) => `(${function (PIP, kind) {
  const W = "ws_" + "p".repeat(32), personal = kind === "personal";
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id, role: id,
    description: "Reads", available: true, unavailable_reason: null, default_name: id, default_goal: "Help",
    engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const pip = { id: PIP, workspace_id: W, pip_type: personal ? "lens" : "rook", name: personal ? "Planner" : "Billing audit", goal: "Help.",
    source_policy: { mode: personal ? "personal" : "committed_only" }, source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0,
    policy: "read_only", trigger: "manual", schedule: null, proposals: [], pending_review_count: 0 };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message",
    inherited_context_size: 1048576, effective_context_size: 8192, context_min: 2048, context_max: 32768,
    thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const run = "run_" + "5".repeat(32);
  const messages = [{ id: "u1", pip_id: PIP, workspace_id: W, role: "user", text: "Is the discount one serious?", run_id: run, status: "succeeded", model: "m", created_at: "2026-10-17T08:59:30.000Z" },
    { id: "a1", pip_id: PIP, workspace_id: W, role: "assistant", text: "Yes. A 10% discount takes the whole total off.\n\nAny order with a discount is charged the wrong amount.", run_id: run, status: "succeeded", model: "m", created_at: "2026-10-17T09:00:00.000Z" }];
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: W, name: personal ? "Personal" : "shop", kind: personal ? "personal" : "git" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: () => ({ setups: [] }), list_pip_starters: () => ({ starters: [] }),
    list_pips: () => ({ pips: [pip], total: 1, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: () => ({ context: { workspace_id: W, revision: 0, entries: [] } }),
    list_pip_models: () => ({ default_model: "m", models: [], connection: "configured" }),
    list_pip_messages: () => ({ pip_id: PIP, workspace_id: W, messages, next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: () => ({ pip_id: PIP, workspace_id: W, posts: [], next_before_id: null }),
    list_pip_reply_stats: () => ({ pip_id: PIP, stats: [] }),
    list_pip_apps: () => ({ apps: [] }), get_pips_limit: () => ({ max_pips: 100, default: 100, maximum: 100000 }),
    get_pip: () => ({ pip }), list_pip_runs: () => ({ runs: [] }),
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    const make = m?.type === "pipsRequest" && answers[m.request.type];
    if (make) setTimeout(() => window.postMessage({ type: "pipsReply", id: m.id, ok: true, result: make() }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 65, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(PIP)}, ${JSON.stringify(kind)});`;
const pageFor = (kind) => `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
  + `<script>${hostFor(kind)}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

// What Chromium paints for the chat's pieces.
async function painted(kind) {
  const context = await browser.newContext({ viewport: { width: 640, height: 800 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: pageFor(kind), contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector(`[data-job="${PIP}"]`);
  await p.click(`[data-job="${PIP}"]`);
  await p.waitForSelector("article.pip-message.assistant .reply-part");
  await p.mouse.move(0, 0);
  await p.waitForTimeout(300);
  const look = await p.evaluate(() => {
    const style = (sel, ...props) => { const n = document.querySelector(sel); if (!n) return null; const s = getComputedStyle(n); return Object.fromEntries(props.map((k) => [k, s[k]])); };
    const opacity = (el) => { let o = 1; for (let e = el; e; e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
    const reply = document.querySelector("article.pip-message.assistant[data-message]");
    return {
      shell: document.querySelector(".pip-app-root, body").className.includes("simple-pips") ? "simple" : "page",
      you: style("article.pip-message.user .bubble", "backgroundColor", "color", "borderTopLeftRadius"),
      reply: style("article.pip-message.assistant .reply-part", "backgroundColor", "borderTopLeftRadius"),
      parts: reply.querySelectorAll(".reply-part").length,
      buttons: Math.max(...[...reply.querySelectorAll(".response-actions button")].map(opacity)),
      time: opacity(reply.querySelector(".response-actions time.msg-time")),
      whatItDid: style("article.pip-message.assistant .chat-activity-toggle", "display"),
      box: style(".pip-composer", "borderTopLeftRadius"),
      hint: style(".composer-hint", "display"),
    };
  });
  await context.close();
  return look;
}

test("a Project Pip’s chat paints as a Personal Pip’s, in its own page", async (t) => {
  if (skipOrFail(t)) return;
  const personal = await painted("personal"), project = await painted("project");
  assert.equal(personal.shell, "simple");
  assert.equal(project.shell, "page", "a Project Pip keeps its page");
  const { shell: _a, ...personalChat } = personal, { shell: _b, ...projectChat } = project;
  assert.deepEqual(projectChat, personalChat, "the same chat");
  assert.equal(project.you.color, "rgb(255, 255, 255)", "your message: white on the accent");
  assert.equal(project.you.backgroundColor, "rgb(109, 73, 232)");
  assert.equal(project.reply.borderTopLeftRadius, "18px", "its reply: short rounded bubbles");
  assert.equal(project.parts, 2, "a bubble a paragraph");
  assert.equal(project.buttons, 0, "the buttons wait for the pointer");
  assert.equal(project.time, 1, "the time shows without it");
  assert.equal(project.whatItDid.display, "none", "What it did is one click away, in the reply's details");
  assert.equal(project.box.borderTopLeftRadius, "22px");
  assert.equal(project.hint.display, "none");
});
