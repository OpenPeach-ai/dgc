// The real Work page in Chromium with the pile above the prompt box: a chat long enough to fill the transcript, a
// running turn, and any of a goal, a troupe, two monitors, a checklist and this chat's changes -- a user's
// "troupe, then a watcher, and maybe tasks and also a Goal". Shared by rail-chips-layout.test.mjs (assertions) and
// capture scripts. setContent only; no port is opened. Not a *.test.mjs file.
import { THEMES, panelHtml } from "./options-scene.mjs";

export const ALL_KINDS = ["goal", "troupe", "monitors", "tasks", "changes"];
// Every kind the bar above the box can show, in the order it shows them (the queue is `queued`, a count).
export const NINE_KINDS = ["queue", "goal", "troupe", "monitors", "tasks", "changes", "pips", "pipfixes", "piprunning"];
const PIP_RUN = "run_" + "a".repeat(32), PIP_ID = "pip_" + "b".repeat(32);
export const TROUPE = { run_id: "tr-0123456789", title: "Review every API handler", state: "running", reason: "",
  agents_planned: 11, reused: 0, journal: "/home/me/.dgc/troupes/tr-0123456789",
  stages: [{ name: "review", total: 8, done: 5, failed: 0, kept: 0 }, { name: "verify", total: 0, done: 0, failed: 0, kept: 0 }] };

// `pips`: the backend also reports Pip fixes and running Pips, so `show` can add them later.
// `attention`: one task blocked and three monitor events held for your next message (wake-ups paused).
export async function openRailScene(browser, { width = 460, height = 820, theme = "dark-modern", reducedMotion = false,
  kinds = ALL_KINDS, attention = false, queued = 0, scale = 1, pips = false } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale,
    reducedMotion: reducedMotion ? "reduce" : "no-preference" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const post = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const send = (event) => post({ type: "event", event });
  await post({ type: "session_ready", sessionId: "s1" });
  await send({ type: "ready", version: "0.48.0", protocol_version: 14, session_id: "s1",
    capabilities: { live_steering: true, agents: true, agent_control: true,
      ...(pips || kinds.includes("pipfixes") ? { pip_reports: 1, pip_fix: 1 } : {}),
      ...(pips || kinds.includes("piprunning") ? { pip_reports: 1, pip_runs_running: 1 } : {}) },
    model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true,
    commands: [], custom_commands: [], goal: { text: "", status: "none" }, context_size: 1048576 });
  for (let n = 0; n < 6; n++) {
    await send({ type: "turn_start", turn_id: `h${n}`, prompt: `Earlier question number ${n + 1} about the settings page`, kind: "prompt" });
    await send({ type: "text_delta", text: "Done. The short answer is in the files above, and nothing else changed. ".repeat(3) });
    await send({ type: "stream_end", message_id: `h${n}:1`, phase: "answer" });
    await send({ type: "turn_end", turn_id: `h${n}`, reason: "completed", token_estimate: 0, final_message_id: `h${n}:1` });
  }
  await send({ type: "turn_start", turn_id: "t1", prompt: "Ship the settings migration and harden the auth flow", kind: "prompt" });
  await send({ type: "text_delta", text: "I'll split this: a troupe reviews the handlers, and I'll do the migration myself." });
  await send({ type: "stream_end", message_id: "t1:0", phase: "commentary" });
  let queueNow = 0;
  // Show one more kind; the scene's own kinds are shown in turn below.
  const show = async (kind) => {
    if (kind === "goal") {
      await send({ type: "goal_changed", goal: "Ship the settings migration and harden the auth flow, with tests on every platform",
        status: "active", elapsed_seconds: 4320, details: {} });
    }
    if (kind === "monitors") {
      await send({ type: "monitors", wake_paused: attention, pending_events: attention ? 3 : 0, items: [
        { id: "mon1", description: "Watch the dev server log", command: "tail -f logs/dev.log", state: "running", events: 14 },
        { id: "mon2", description: "CI on PR #482", command: "gh pr checks 482 --watch", state: "running", events: 3 }] });
    }
    if (kind === "troupe") await send({ type: "troupe_started", ...TROUPE });
    if (kind === "tasks") {
      await send({ type: "todos", todos: [
        { content: "Read the settings store", status: "done" }, { content: "Write the v2 → v3 migration", status: "done" },
        { content: "Migrate back down (v3 → v2)", status: "done" }, { content: "Tests for both directions", status: "done" },
        { content: "Fix the save handler on the settings page", status: "in_progress" },
        ...(attention ? [{ content: "Publish to the marketplace (needs your token)", status: "blocked" }] : []),
        { content: "Run lint and the type check", status: "pending" }, { content: "Update the changelog", status: "pending" }] });
    }
    if (kind === "changes") {
      await post({ type: "chat_changes", sessionId: "", total: 6, additions: 214, deletions: 37,
        files: ["src/settings.ts", "test/settings.test.ts", "src/auth/keys.ts", "src/api/admin.ts", "CHANGELOG.md", "docs/settings.md"]
          .map((path, i) => ({ path, additions: [96, 71, 22, 14, 8, 3][i], deletions: [12, 0, 9, 3, 0, 13][i], status: "modified" })) });
    }
    if (kind === "pipfixes") {
      await send({ type: "pip_report", report: { run_id: PIP_RUN, pip_id: PIP_ID, name: "Daily audit", pip_type: "scout", kind: "audit",
        outcome: "findings", finished_at: "2026-10-18T13:00:00.000Z", earlier: 0, total: 1, counts: { high: 1 },
        findings: [{ title: "The total skips a tax line", severity: "high", path: "app/tax.py", line: 88 }] } });
      await send({ type: "pip_fix", fix: { fix_id: "fix_" + "c".repeat(32), run_id: PIP_RUN, pip_id: PIP_ID, name: "Daily audit",
        pip_type: "scout", agent_id: "sub-0123456789ab", created_at: Date.now() / 1000 - 30, state: "running", started_at: Date.now() / 1000 - 5 } });
    }
    if (kind === "piprunning") {
      await send({ type: "pip_runs_running", request_id: "w1", items: [
        { run_id: "run_" + "1".repeat(32), pip_id: "pip_" + "d".repeat(32), name: "Billing audit", pip_type: "rook",
          started_at: new Date(Date.now() - 42000).toISOString(), trigger: "schedule" },
        { run_id: "run_" + "2".repeat(32), pip_id: "pip_" + "e".repeat(32), name: "Docs watcher", pip_type: "scout",
          started_at: new Date(Date.now() - 120000).toISOString(), trigger: "you" }] });
    }
    // What Pips found: its row is filled by the digest bar (src/pipDigestBar.js), which this page does not load, so the
    // row is shown as that module would show it; the `queued` event below re-reads the rail.
    if (kind === "pips") {
      await page.evaluate(() => { document.getElementById("pips-digest-text").textContent = "2 new findings from Commit reviewer";
        document.getElementById("pipsbar").hidden = false; });
    }
    if (kind === "queue") queueNow = queued || 2;
    if (kind === "queue" || kind === "pips") await send({ type: "queued", count: queueNow });
  };
  for (const kind of ["goal", "monitors", "troupe", "tasks", "changes", "pipfixes", "piprunning", "pips"]) if (kinds.includes(kind)) await show(kind);
  if (queued) await show("queue");
  await page.waitForTimeout(150);
  // The bar eases to its height when it first appears: measure it at rest.
  await page.evaluate(() => Promise.all(document.getElementById("rail-line").getAnimations().map((a) => a.finished.catch(() => {}))));
  return { page, send, post, errors, show };
}

/** The pile, measured: from the footer's top to the prompt box, the transcript's height, and the chip line. */
export function measurePile(page) {
  return page.evaluate(() => {
    const rect = (node) => node.getBoundingClientRect();
    const foot = rect(document.querySelector("footer")), box = rect(document.getElementById("cbox"));
    return { above: Math.round(box.top - foot.top), log: Math.round(rect(document.getElementById("log")).height) };
  });
}
