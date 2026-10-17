// The real panel in Chromium with the agent map's realistic chat: a running turn on a named chat, four
// sub-agents (one working with a working child of its own, one failed, one finished) and four
// background tasks (a monitor, a background shell, a troupe and an artifact preview). Shared by
// agent-map-layout.test.mjs (assertions) and render-agent-map.mjs (the before/after captures).
// setContent only; no port is opened. `root` points at another checkout's editors/vscode, so the
// same chat can be drawn by the panel as it was before the map.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSync } from "esbuild";
import { THEMES } from "./options-scene.mjs";

const here = dirname(fileURLToPath(import.meta.url)) + "/../..";
const cache = new Map();
export function mapPanelHtml(root = here) {
  if (cache.has(root)) return cache.get(root);
  const panelSrc = readFileSync(root + "/src/panel.ts", "utf8");
  const css = readFileSync(root + "/media/main.css", "utf8");
  const codicon = readFileSync(here + "/media/codicon.css", "utf8").replace(/url\([^)]*codicon\.ttf[^)]*\)/,
    `url("data:font/ttf;base64,${readFileSync(here + "/media/codicon.ttf").toString("base64")}")`);
  // A message's time (DgcTime), which the panel loads before main.js.
  const mainJs = readFileSync(here + "/media/msgtime.js", "utf8") + "\n" + readFileSync(root + "/media/main.js", "utf8");
  const markdownJs = buildSync({ entryPoints: [here + "/src/markdown.ts"], bundle: true, format: "iife",
    globalName: "DgcMarkdown", write: false, platform: "browser" }).outputFiles[0].text;
  const skeleton = [...panelSrc.matchAll(/<!doctype html>[\s\S]*?<\/body><\/html>/gi)].map((m) => m[0])
    .find((c) => c.includes('id="input"')).replace(/\$\{[^}]*\}/g, "");
  const out = { html: skeleton.replace("</head>", `<style>${codicon}</style><style>${css}</style></head>`), mainJs, markdownJs };
  cache.set(root, out);
  return out;
}

export const sid = (n) => `sub-${String(n).padStart(12, "0")}`;
export const AGENTS = [
  { n: 1, call: "call_1", description: "Review the auth module for token leaks", agent_type: "reviewer", run: 267000, tokens: 142600, tools: 31,
    prompt: "Read src/auth/ end to end and list every place a token can reach a log, an error message or a URL." },
  { n: 2, parent: 1, call: `${sid(1)}:call_1`, description: "Trace where refresh tokens are stored", run: 95000, tokens: 38400, tools: 12,
    prompt: "Find every write of a refresh token and say which store keeps it." },
  { n: 3, call: "call_2", description: "Benchmark the cold start of the CLI on every platform we ship", end: "failed", run: 48000,
    tokens: 18200, tools: 9, message: "HTTP 502 from the model provider: the upstream timed out" },
  { n: 4, call: "call_3", description: "Write the settings migration and its tests", end: "finished", run: 212000, tokens: 97200, tools: 44,
    message: "Migrated the settings store to version 3 and covered both directions.\nFILES: src/settings.ts, test/settings.test.ts" },
];

// Opens the panel at width x height in `theme`, plays the chat in, and (with `open`) clicks the
// agents pill. The agents arrive live, so the panel as it was before the map lists every one of
// them too; the page's clock is moved on between them so the durations read like a real run.
export async function openMapScene(browser, { width, height = 720, theme = "dark-modern", root = here, open = true,
  forcedColors = false, reducedMotion = true, faces = false } = {}) {
  const { html, mainJs, markdownJs } = mapPanelHtml(root);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2,
    reducedMotion: reducedMotion ? "reduce" : "no-preference", forcedColors: forcedColors ? "active" : "none" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  if (faces) {
    // The real face marks (media/agents), as the panel loads them from data-agent-marks. Without them
    // the panel draws its fallback shapes, which is what a layout test wants and a screenshot doesn't.
    await page.route("https://marks.test/**", (route) => route.fulfill({ contentType: "image/svg+xml",
      body: readFileSync(join(root, "media", "agents", new URL(route.request().url()).pathname.slice(1))) }));
  }
  await page.setContent(html, { waitUntil: "load" });
  if (faces) await page.evaluate(() => { document.body.dataset.agentMarks = "https://marks.test"; });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    // A clock the scene can move on: performance.now is what the panel times agents by.
    let skew = 0;
    const real = performance.now.bind(performance);
    performance.now = () => real() + skew;
    window.__skew = (ms) => { skew += ms; };
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [mainJs, markdownJs]);
  const post = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const send = (event) => post({ type: "event", event });
  const now = Date.now() / 1000;
  const model = "qwen3.8:27b";
  await post({ type: "session_ready", sessionId: "s1" });
  await send({ type: "ready", version: "0.48.0", protocol_version: 14, session_id: "s1", session_name: "Harden the auth flow",
    capabilities: { live_steering: true, agents: true, agent_control: true, monitors: true, troupe: true, background_tasks: { version: 1 } },
    model, mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true, commands: [],
    custom_commands: [], goal: { text: "", status: "none" }, context_size: 1048576 });
  await post({ type: "state", state: { model, mode: "default", think: "off" } });
  await send({ type: "context", used: 464400, size: 1048576 });
  await send({ type: "turn_start", turn_id: "t1", prompt: "Harden the auth flow and ship the settings migration" });
  // Oldest first: each agent starts, the clock moves on by the time it has been (or was) at work.
  const order = [...AGENTS].sort((a, b) => b.run - a.run);
  for (const [i, agent] of order.entries()) {
    await send({ type: "tool_call", call_id: agent.call, name: "task", args: { description: agent.description, prompt: agent.prompt || agent.description },
      summary: "" });
    await send({ type: "agent_started", id: sid(agent.n), parent_id: agent.parent ? sid(agent.parent) : null, call_id: agent.call,
      description: agent.description, depth: agent.parent ? 2 : 1, state: "running", started_at: now - agent.run / 1000,
      isolated: false, parallel: true, ...(agent.agent_type ? { agent_type: agent.agent_type } : {}) });
    await page.evaluate((ms) => window.__skew(ms), agent.run - (order[i + 1]?.run ?? 0));
  }
  // The reviewer's own steps (hidden in the chat; its transcript draws them): two finished, one at work.
  const step = (n, name, args, summary, output) => [
    { type: "tool_call", call_id: `${sid(1)}:s${n}`, name, args, summary },
    ...(output === null ? [] : [{ type: "tool_result", call_id: `${sid(1)}:s${n}`, name, output, is_error: false }])];
  for (const ev of [
    ...step(1, "read_file", { path: "src/auth/session.ts" }, "src/auth/session.ts",
      "export function saveSession(res, token) {\n  log.info(`session for ${token.refresh}`);\n  res.cookie(\"sid\", token.id);\n}"),
    ...step(2, "grep", { pattern: "refresh" }, "refresh · src/auth", "src/auth/session.ts:2: log.info(`session for ${token.refresh}`)\nsrc/auth/store.ts:14: db.put(\"refresh\", token.refresh)"),
    ...step(3, "bash", { command: "npm test -- auth" }, "npm test -- auth", null)]) await send(ev);
  for (const agent of AGENTS) {
    if (agent.end) {
      await send({ type: "agent_ended", id: sid(agent.n), state: agent.end, duration_ms: agent.run, tool_calls: agent.tools,
        tokens: agent.tokens, message: agent.message });
    } else {
      await send({ type: "agent_updated", id: sid(agent.n), state: "running", tool_calls: agent.tools, tokens: agent.tokens });
    }
  }
  await send({ type: "monitors", wake_paused: false, pending_events: 0, items: [{ id: "mon1", description: "Watch the dev server log",
    command: "tail -f logs/dev.log", state: "running", events: 14, pending_events: 0, persistent: true, timeout_ms: 0, started_at: Math.floor(now - 10563) }] });
  await send({ type: "background_shells", items: [{ id: "bg3", command: "npm run dev", state: "running", started_at: now - 187,
    ended_at: null, exit_code: null, agent_id: null }] });
  await send({ type: "troupe_started", run_id: "tr-0123456789", title: "Review every API handler", state: "running", reason: "",
    stages: [{ name: "review", total: 8, done: 5, failed: 0, kept: 0 }, { name: "verify", total: 0, done: 0, failed: 0, kept: 0 }],
    agents_planned: 11, reused: 0, journal: ".dgc/troupes/tr-0123456789" });
  await send({ type: "artifact_ready", id: "art1", name: "settings preview", url: "http://127.0.0.1:8765/?a=art1", rel: "settings" });
  await page.waitForTimeout(80);
  if (open) {
    await page.click("#agents-pill");
    await page.waitForTimeout(120);
  }
  return { page, send, post, errors };
}

// The facts the layout test checks, read from the live page.
export function measureMap(page) {
  return page.evaluate(() => {
    const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const dialog = document.getElementById("agent-map-box"), body = document.getElementById("agent-map-body");
    const rows = [...document.querySelectorAll("#agent-map .am-row")].filter((row) => row.offsetParent).map((row) => {
      const desc = row.querySelector(".am-desc"), meta = row.querySelector(".am-meta");
      const ds = getComputedStyle(desc);
      return { key: row.dataset.amKey, box: box(row), desc: box(desc), descClipped: desc.scrollWidth > desc.clientWidth,
        descNoWrap: ds.whiteSpace === "nowrap", descEllipsis: ds.textOverflow === "ellipsis", descLine: parseFloat(ds.lineHeight),
        metaHeight: meta.getBoundingClientRect().height, metaLine: parseFloat(getComputedStyle(meta).lineHeight),
        text: desc.textContent, title: row.getAttribute("title") || "" };
    });
    // Every elbow and spine is a pseudo-element of a child's item: where it is drawn, on the page.
    const connectors = [...document.querySelectorAll("#agent-map-tree .am-children > .am-node")].map((item) => {
      const row = item.querySelector(":scope > .am-self > .am-row"), r = box(item), rowBox = box(row);
      const before = getComputedStyle(item, "::before"), after = getComputedStyle(item, "::after");
      const elbowY = r.top + parseFloat(before.top) + parseFloat(before.borderTopWidth) / 2;
      const elbowLeft = r.left + parseFloat(before.left), elbowRight = elbowLeft + parseFloat(before.width);
      const spine = after.display === "none" ? null : { left: r.left + parseFloat(after.left), top: r.top + parseFloat(after.top),
        bottom: r.top + parseFloat(after.top) + parseFloat(after.height) };
      return { key: row.dataset.amKey, rowMiddle: rowBox.top + rowBox.height / 2, rowLeft: rowBox.left, elbowY, elbowLeft, elbowRight,
        elbowColor: before.borderTopColor, spine };
    });
    const stubs = [...document.querySelectorAll("#agent-map-tree .am-children")].filter((list) => list.childElementCount).map((list) => {
      const s = getComputedStyle(list, "::before"), r = box(list);
      const parentRow = list.parentElement.querySelector(":scope > .am-self > .am-row");
      return { content: s.content, top: r.top + parseFloat(s.top), parentMiddle: parentRow ? box(parentRow).top + box(parentRow).height / 2 : null };
    });
    return {
      layout: dialog.dataset.layout, view: dialog.dataset.view, open: !document.getElementById("agent-map").hidden,
      inner: { width: innerWidth, height: innerHeight },
      pageOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
      dialog: box(dialog), bodyOverflow: body.scrollWidth - body.clientWidth, rows, connectors, stubs,
      focus: document.activeElement?.dataset?.amKey || document.activeElement?.id || "",
      subtitle: document.getElementById("agent-map-subtitle").textContent,
      tasksTitle: document.getElementById("agent-map-tasks-title").textContent,
    };
  });
}
