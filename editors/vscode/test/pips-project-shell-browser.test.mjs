// A Project Pip's page is the Personal Pips page (the founder, 24 Oct: "yes, do it"), drawn by the real client and its
// CSS in real Chromium at the side bar's narrow width and a wide editor tab: the project's home with its menu and setup
// card, a Project Pip's chat with Run now and its menu open, History, Settings, the project's context, the new-Pip dialog
// and the describe-the-job page. Nothing may stick out of the page or be cut off by a box it sits in, and the top bar's
// buttons stay whole beside the Pip's name. jsdom can't see any of that. SHOTS=<dir> also saves what each view painted.
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
const AUDIT = "pip_" + "a".repeat(32);

// Personal and a project ("shop"), the project with a Rook that has a run post and a change waiting for you, a Quill,
// and a setup card from the DGC chat.
const host = `(${function (AUDIT) {
  const P = "ws_" + "e".repeat(32), W = "ws_" + "d".repeat(32), RUN = "run_" + "1".repeat(32), DOCS = "pip_" + "b".repeat(32), NOW = Date.now(), iso = (ms) => new Date(ms).toISOString();
  const types = ["core", "scout", "lens", "patch", "rook", "pulse", "lock", "quill"].map((id, character_index) => ({ id, character_index, name: id[0].toUpperCase() + id.slice(1),
    role: { scout: "Repository exploration", lens: "Repository research", patch: "Code changes", rook: "Code review", pulse: "Test execution", lock: "Security review", quill: "Documentation drafts", core: "Main chat" }[id],
    description: "Reads the committed code of this project and reports what it finds, with the lines it quotes.", available: id !== "core", unavailable_reason: id === "core" ? "Core is the main chat." : null,
    default_name: id[0].toUpperCase() + id.slice(1), default_goal: "Review the committed code.", engine: id === "patch" ? "patch" : id === "pulse" ? "test" : id === "quill" ? "documentation_draft" : "source_audit" }));
  const schedule = { type: "daily", time: "09:00", timezone: "Asia/Kolkata", missed_policy: "coalesce_latest", dst_policy: "skip_gap_first_fold" };
  const base = { workspace_id: W, source_ref: "HEAD", status: "active", current_version: 1, lifecycle_revision: 0, policy: "read_only", trigger: "manual", schedule: null, source_policy: { mode: "committed_only" } };
  const audit = { ...base, id: AUDIT, pip_type: "rook", name: "Billing audit", goal: "Look for bugs in how billing.py computes invoice totals, GST and discounts.", report_session: "chat-shop", report_chats: 1,
    latest_run: { id: RUN, status: "succeeded" }, pending_review_count: 1,
    proposals: [{ id: "prop_" + "c".repeat(32), approval_status: "pending", reason: "Run it every morning.", actor: "local-console", expires_at: iso(NOW + 86400000), definition: { name: "Billing audit", goal: "Look for bugs in how billing.py computes invoice totals, GST and discounts.", source_ref: "HEAD", pip_type: "rook", schedule } }] };
  const docs = { ...base, id: DOCS, pip_type: "quill", name: "Docs writer", goal: "Write a short guide to billing.py for new developers.", proposals: [], pending_review_count: 0 };
  const planner = { ...base, workspace_id: P, id: "pip_" + "f".repeat(32), pip_type: "lens", name: "Planner", goal: "Plan my week.", source_policy: { mode: "personal" }, proposals: [], pending_review_count: 0 };
  const setup = { id: "setup_" + "3".repeat(32), digest: "a".repeat(64), workspace_id: W, project_root: "/home/me/projects/shop", pip_id: null, name: "Nightly review",
    goal: "Review the day’s committed changes to billing.py for bugs in totals, GST and discounts.", pip_type: "lock", work_kind: "source_review", source_ref: "HEAD", schedule: { ...schedule, time: "22:00" },
    run_now: false, next_run_at: iso(NOW + 3600000), status: "pending", created_at: iso(NOW - 60000), expires_at: iso(NOW + 3600000), receipt: null, reason: "You asked the DGC chat for a nightly review.",
    expected_version: null, expected_lifecycle_revision: null, permissions: "read_only", source_policy: "committed_only", runner_notice: "A schedule runs only while the local Pips runner is enabled and running.",
    scope_notice: "This reviews source only. It does not test the running app.", run_now_policy: null };
  const controls = { version: 1, mode: "read_only", options: { context_size: 8192, thinking: "off" }, options_source: "last_message", inherited_context_size: 1048576, effective_context_size: 8192,
    context_min: 2048, context_max: 32768, thinking_levels: ["off", "low", "medium", "high", "xhigh"], reasoning_control: "provider_dependent", reasoning_note: "n", context_note: "n" };
  const chat = "run_" + "5".repeat(32);
  const messages = [{ id: "u1", pip_id: AUDIT, workspace_id: W, role: "user", text: "Is the discount one serious?", run_id: chat, status: "succeeded", model: "m", created_at: iso(NOW - 3600000) },
    { id: "a1", pip_id: AUDIT, workspace_id: W, role: "assistant", text: "Yes. A 10% discount takes the whole total off.\n\nAny order with a discount is charged the wrong amount.", run_id: chat, status: "succeeded", model: "m", created_at: iso(NOW - 3590000) }];
  const post = { run_id: RUN, pip_id: AUDIT, name: "Billing audit", pip_type: "rook", kind: "audit", trigger: "you", text: "x", outcome: "findings", posted_at: iso(NOW - 7200000), finished_at: iso(NOW - 7200000),
    total: 2, counts: { high: 2 }, findings: [{ title: "invoice_total overwrites the subtotal on every line", severity: "high", path: "billing.py", line: 12 }, { title: "apply_discount divides by 10 instead of 100", severity: "high", path: "billing.py", line: 20 }] };
  const run = { id: RUN, pip_id: AUDIT, workspace_id: W, status: "succeeded", created_at: iso(NOW - 7300000), manifest: { run_kind: "audit", job_version: 1, source_revision: "a".repeat(40), trigger: "manual" }, result: null };
  const pips = { [P]: [planner], [W]: [audit, docs] }, byId = Object.fromEntries([audit, docs, planner].map((p) => [p.id, p]));
  const answers = {
    list_workspaces: () => ({ workspaces: [{ id: P, name: "Personal", kind: "personal" }, { id: W, name: "shop", kind: "git" }], current_workspace_id: W }),
    list_pip_types: () => ({ types }), list_pip_setups: (r) => ({ setups: r.workspace_id === W ? [setup] : [] }), get_pip_setup: () => ({ setup }),
    list_pip_starters: () => ({ starters: [{ id: "daily_review", title: "Daily code review", summary: "Reviews the committed code every day.", scope: "project", params: ["time", "timezone"] }] }),
    list_pips: (r) => ({ pips: pips[r.workspace_id] || [], total: (pips[r.workspace_id] || []).length, next_offset: null }),
    get_pip_runner: () => ({ runner: { runner_id: "r", status: "running", online: true, paused: false, counts: { queued: 0, running: 0, cancelling: 0 } } }),
    get_workspace_context: (r) => ({ context: { workspace_id: r.workspace_id, revision: 1, entries: [] } }),
    list_pip_models: () => ({ default_model: "deepseek-v4.1-flash:cloud", models: [{ id: "deepseek-v4.1-flash:cloud", name: "deepseek-v4.1-flash:cloud" }, { id: "glm-5.3:cloud", name: "glm-5.3:cloud" }], connection: "configured" }),
    list_pip_messages: (r) => ({ pip_id: r.pip_id, workspace_id: byId[r.pip_id].workspace_id, messages: r.pip_id === AUDIT ? messages : [], next_before_id: null, active_run: null, history_context_omitted_count: 0, chat_controls: controls }),
    list_pip_run_posts: (r) => ({ pip_id: r.pip_id, workspace_id: byId[r.pip_id].workspace_id, posts: r.pip_id === AUDIT ? [post] : [], next_before_id: null }),
    list_pip_run_fixes: (r) => ({ pip_id: r.pip_id, workspace_id: byId[r.pip_id].workspace_id, fixes: [] }),
    list_pip_reply_stats: (r) => ({ pip_id: r.pip_id, stats: [] }),
    get_pip: (r) => ({ pip: byId[r.pip_id] }), list_pip_runs: (r) => ({ runs: r.pip_id === AUDIT ? [run] : [] }),
    get_pip_run: () => ({ run: { ...run, result: { summary: "Two high findings.", findings: [], limitations: [] } } }),
    list_pip_notifications: (r) => ({ workspace_id: r.workspace_id, notifications: [], unread_count: 0, next_before_seq: null, sync_pending: false, history_may_be_incomplete: false }),
    list_pip_approvals: () => ({ approvals: [], next_cursor: null }), list_pip_checkpoints: () => ({ checkpoints: [], next_cursor: null }),
  };
  window.acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage(m) {
    const make = m?.type === "pipsRequest" && answers[m.request.type];
    if (make) setTimeout(() => window.postMessage({ type: "pipsReply", id: m.id, ok: true, result: make(m.request) }, "*"), 1);
  } });
  setTimeout(() => window.postMessage({ type: "pipsConnection", apiVersion: 65, generation: 1, connected: true, supported: true, enabled: true }, "*"), 5);
}})(${JSON.stringify(AUDIT)});`;
const page = `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${css}</style></head><body><main id="app"></main><div id="review-root"></div>`
  + `<script>${host}</script><script>${js.replace(/<\/script/g, "<\\/script")}</script></body></html>`;

// What sticks out of the page or is cut off by a box it sits in (one that hides what overflows, not one that scrolls),
// and whether the top bar's buttons are whole, apart and inside it.
const MEASURE = () => {
  const vw = document.documentElement.clientWidth, out = [];
  const shown = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
  const name = (e) => `${e.tagName.toLowerCase()}${e.id ? "#" + e.id : ""}${typeof e.className === "string" && e.className ? "." + e.className.trim().split(/\s+/).join(".") : ""} “${(e.textContent || "").trim().slice(0, 30)}”`;
  for (const e of document.querySelectorAll("#app *, #review-root *")) {
    if (!shown(e) || e.closest(".avatar, svg") || e.closest(".sr-only")) continue;
    const r = e.getBoundingClientRect();
    let clip = null;
    for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) { const s = getComputedStyle(a); if (s.overflowX !== "visible") { clip = a; break; } }
    if (!clip) { if (r.right > vw + 1 || r.left < -1) out.push(`${name(e)} sticks out of the page (${Math.round(r.left)}–${Math.round(r.right)} of ${vw})`); continue; }
    const c = clip.getBoundingClientRect(), s = getComputedStyle(clip);
    if (["auto", "scroll"].includes(s.overflowX)) continue;
    if (r.right > c.right + 1 || r.left < c.left - 1) out.push(`${name(e)} is cut off by ${name(clip)}`);
  }
  const bar = document.querySelector(".pip-topbar"), buttons = bar ? [...bar.querySelectorAll(":scope > button, .topbar-actions > *")].filter(shown) : [];
  const box = bar?.getBoundingClientRect(), pill = bar?.querySelector(".pip-pill")?.getBoundingClientRect();
  const topbar = bar ? buttons.map((b) => { const r = b.getBoundingClientRect(); return { what: b.getAttribute("aria-label") || b.id || b.textContent.trim(), inside: r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1,
    clearOfName: !pill || r.right <= pill.left + 1 || r.left >= pill.right - 1, whole: b.scrollWidth <= b.clientWidth + 1 }; }) : null;
  return { out, scroll: document.documentElement.scrollWidth - vw, topbar };
};

async function views(width) {
  const context = await browser.newContext({ viewport: { width, height: 820 }, reducedMotion: "reduce" });
  const p = await context.newPage();
  await p.route("https://pips.test/**", (r) => r.fulfill({ body: page, contentType: "text/html" }));
  await p.goto("https://pips.test/view");
  await p.waitForSelector("[data-pips-tab=project]");
  await p.click("[data-pips-tab=project]");
  await p.waitForSelector(`[data-job="${AUDIT}"]`);
  const seen = {};
  const look = async (name) => {
    await p.waitForTimeout(250);
    seen[name] = await p.evaluate(MEASURE);
    if (process.env.SHOTS) await p.screenshot({ path: `${process.env.SHOTS}/${width}-${name}.png` });
  };
  await look("home");
  await p.click(".simple-home-head .pip-menu > summary"); await look("home-menu");
  await p.click("#workspace-context"); await p.waitForSelector(".simple-content[data-view=context]"); await look("project-context");
  await p.click("#workspace-back");
  await p.click(`[data-job="${AUDIT}"]`);
  await p.waitForSelector("article.run-post");
  await look("pip-chat");
  await p.click(".pip-topbar .pip-menu > summary"); await look("pip-menu");
  await p.click(".pip-topbar .pip-menu [data-tab=runs]"); await p.waitForSelector(".simple-content[data-view=runs] .run-row"); await look("history");
  await p.click(".pip-topbar .pip-menu > summary"); await p.click(".pip-topbar .pip-menu [data-tab=job]"); await p.waitForSelector(".simple-content[data-view=job]"); await look("settings");
  await p.click("#simple-to-chat"); await p.click("#simple-back");
  await p.click("#simple-new"); await p.waitForSelector(".dialog #new-pip-kind");
  await p.click(".dialog #new-pip-kind"); await p.click(".dialog #new-pip-kind-list [data-pick=rook]"); await p.waitForSelector(".dialog #name"); await look("new-pip");
  await p.click("#new-pip-describe"); await p.waitForSelector("#setup-prompt-form"); await look("describe");
  await context.close();
  return seen;
}

for (const width of [460, 900]) {
  test(`a Project Pip’s page at ${width} px: nothing sticks out or is cut off, and the top bar’s buttons stay whole`, async (t) => {
    if (skipOrFail(t)) return;
    const seen = await views(width);
    for (const [name, v] of Object.entries(seen)) {
      assert.deepEqual(v.out, [], `${name}: nothing sticks out of the page or is cut off`);
      assert.ok(v.scroll <= 0, `${name}: no sideways scrolling (${v.scroll}px)`);
    }
    for (const name of ["pip-chat", "pip-menu", "history", "settings"]) {
      const bar = seen[name].topbar;
      assert.ok(bar && bar.length >= 3, `${name}: back, Run now and the menu (${JSON.stringify(bar)})`);
      for (const b of bar) assert.deepEqual([b.what, b.inside, b.clearOfName, b.whole], [b.what, true, true, true], `${name}: ${b.what} is whole, inside the bar and clear of the name`);
    }
    assert.ok(seen["pip-chat"].topbar.some((b) => b.what === "Run audit"), "Run now is in the bar");
  });
}
