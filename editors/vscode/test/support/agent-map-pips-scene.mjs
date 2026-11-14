// The real panel in Chromium with the agent map open on a Work session that has two helpers of its own and Pips
// related to it (pips-flow-design Q2, picture 9): one Pip working on a job from this session, one that needs you, one
// running, two idle in this folder and five elsewhere. Shared by agent-map-pips-layout.test.mjs (assertions) and
// render-agent-map-pips.mjs (the pictures). setContent only; no port is opened. Sample names only.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { mapPanelHtml, sid } from "./agent-map-scene.mjs";
import { THEMES } from "./options-scene.mjs";

const hex = (c) => c.repeat(32);
export const PIPS = { tax: "pip_" + hex("a"), billing: "pip_" + hex("b"), stock: "pip_" + hex("c"), docs: "pip_" + hex("d"), notes: "pip_" + hex("e") };
export const RUN = "run_" + hex("1");
export const RELATED = [
  { id: PIPS.tax, name: "Tax watchdog", pip_type: "rook", why: ["asked", "folder"], running: true, needs_you: 0 },
  { id: PIPS.billing, name: "Billing audit", pip_type: "lens", why: ["set_up", "folder"], running: false, needs_you: 1 },
  { id: PIPS.stock, name: "Stock sync check", pip_type: "pulse", why: ["folder"], running: true, needs_you: 0 },
  { id: PIPS.docs, name: "Docs writer", pip_type: "quill", why: ["folder"], running: false, needs_you: 0 },
  { id: PIPS.notes, name: "Release notes", pip_type: "scout", why: ["folder"], running: false, needs_you: 0 },
];
// The Pips' faces as the panel loads them (media/pips/plush.js), with the bodies' picture inlined.
const faceScript = readFileSync(fileURLToPath(new URL("../../media/pips/plush.js", import.meta.url)), "utf8")
  .replace(/const asset=[^\n]+;/, `const asset='data:image/webp;base64,${readFileSync(
    fileURLToPath(new URL("../../media/pips/plush-bodies.webp", import.meta.url))).toString("base64")}';`);

export async function openPipsMapScene(browser, { width, height = 720, theme = "dark-modern", related = RELATED, elsewhere = 5, hidden = false,
  names = {}, faces = true } = {}) {
  const { html, mainJs, markdownJs } = mapPanelHtml();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion: "reduce" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate((t) => document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark"), theme);
  await page.evaluate(([mjs, mdjs, faceJs]) => {
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage: (m) => window.__posted.push(m), getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    if (faceJs) {
      eval(faceJs);
      const style = document.createElement("style"); style.textContent = window.PipConcepts.plush.styles; document.head.append(style);
    }
    eval(mjs);
  }, [mainJs, markdownJs, faces ? faceScript : ""]);
  const post = (data) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: d })), data);
  const send = (event) => post({ type: "event", event });
  const now = Date.now() / 1000, model = "qwen3.8:27b";
  await post({ type: "session_ready", sessionId: "s1" });
  await send({ type: "ready", version: "0.52.0", protocol_version: 14, session_id: "s1", session_name: "Tidy the October invoices",
    capabilities: { live_steering: true, agents: true, agent_control: true, pips_supported: true, pips_enabled: true, pips_api_version: 96, pip_runs_running: 1 },
    model, mode: "default", think: "off", base_url: "http://127.0.0.1:11434/v1", workspace_trusted: true, commands: [],
    custom_commands: [], goal: { text: "", status: "none" }, context_size: 1048576 });
  await post({ type: "state", state: { model, mode: "default", think: "off" } });
  await send({ type: "turn_start", turn_id: "t1", prompt: "Tidy the October invoices" });
  const helpers = [{ n: 1, description: "Renumber the October invoices", run: 100 }, { n: 2, description: "Find invoices with a gap in their numbers", run: 52, end: "finished" }];
  for (const helper of helpers) {
    await send({ type: "tool_call", call_id: `call_${helper.n}`, name: "task", args: { description: helper.description, prompt: helper.description }, summary: "" });
    await send({ type: "agent_started", id: sid(helper.n), parent_id: null, call_id: `call_${helper.n}`, description: helper.description, depth: 1,
      state: "running", started_at: now - helper.run, isolated: false, parallel: true });
    if (helper.end) await send({ type: "agent_ended", id: sid(helper.n), state: helper.end, duration_ms: helper.run * 1000, tool_calls: 6, tokens: 8400, message: "Two gaps: 1041 and 1077." });
  }
  await send({ type: "pip_runs_running", items: [{ run_id: RUN, pip_id: PIPS.tax, name: names.tax || "Tax watchdog", pip_type: "rook",
    started_at: new Date(Date.now() - 240000).toISOString(), trigger: "chat" }] });
  await page.click("#agents-pill");
  await page.waitForTimeout(80);
  const seq = await page.evaluate(() => window.__posted.filter((m) => m.type === "agentMapPips").at(-1)?.seq);
  await post({ type: "agentMapPips", seq, pips: related, elsewhere, hidden });
  await page.waitForTimeout(120);
  return { page, send, post, errors, seq };
}

// What the layout test checks, read from the live page.
export function measurePips(page) {
  return page.evaluate(() => {
    const box = (node) => { const r = node.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
    const corner = (node) => { const s = getComputedStyle(node); return Math.max(...[s.borderTopLeftRadius, s.borderTopRightRadius, s.borderBottomRightRadius, s.borderBottomLeftRadius].map((v) => parseFloat(v) || 0)); };
    const probe = document.createElement("i"); probe.style.cssText = "position:absolute;visibility:hidden;border-radius:var(--btn-r);height:var(--btn-h-sm)"; document.body.append(probe);
    const family = parseFloat(getComputedStyle(probe).borderTopLeftRadius), small = probe.getBoundingClientRect().height; probe.remove();
    const section = document.getElementById("agent-map-pips"), dialog = document.getElementById("agent-map-box"), body = document.getElementById("agent-map-body");
    const rows = [...section.querySelectorAll(".am-pip")].map((row) => {
      const name = row.querySelector(".am-pip-name"), tag = row.querySelector(".am-pip-tag"), act = row.querySelector("button"), face = row.querySelector(".am-pip-face");
      return { box: box(row), name: box(name), nameText: name.textContent, nameClipped: name.scrollWidth > name.clientWidth, tag: tag.hidden ? null : { box: box(tag), corner: corner(tag) },
        meta: box(row.querySelector(".am-pip-meta")), act: { box: box(act), corner: corner(act), text: act.textContent }, face: box(face), plush: !!face.querySelector(".dgc-plush") };
    });
    const controls = [...section.querySelectorAll("button")].filter((b) => b.checkVisibility()).map((b) => ({ text: b.textContent, box: box(b), corner: corner(b) }));
    const count = document.getElementById("agent-map-pips-count");
    return { hidden: section.hidden, family, small, section: box(section), dialog: box(dialog), settings: box(document.getElementById("agent-map-settings")),
      tree: box(document.getElementById("agent-map-tree")), inner: { width: innerWidth, height: innerHeight },
      pageOverflow: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth, bodyOverflow: body.scrollWidth - body.clientWidth,
      rows, controls, count: { text: count.textContent, box: box(count), corner: corner(count) }, toggle: box(document.getElementById("agent-map-pips-toggle")),
      head: box(section.querySelector(".am-pips-head")), more: { text: document.getElementById("agent-map-pips-more").textContent, box: box(document.getElementById("agent-map-pips-more")) },
      bodyHidden: document.getElementById("agent-map-pips-body").hidden };
  });
}
