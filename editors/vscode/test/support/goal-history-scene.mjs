// A Work chat whose goal just ended (0.52): the prompt, two finished turns, the one quiet line under the last ("Goal
// done · 2 h 14 min · 1.8M tokens · 7 cycles"), and, with `list`, the "Goals" pill "/goal-history" adds to the bar and
// its list open: three goals, newest first. Shared by goal-history-browser.test.mjs and render-goal-history.mjs.
// Not a *.test.mjs file.
import { readFileSync } from "node:fs";
import { THEMES, panelHtml } from "./options-scene.mjs";

// The panel loads a reply's Trace (media/trace.js, media/trace.css) before its own script; the shared page leaves it out.
const media = new URL("../../media/", import.meta.url);
const traceJs = readFileSync(new URL("trace.js", media), "utf8"), traceCss = readFileSync(new URL("trace.css", media), "utf8");

export const NOW = Date.UTC(2026, 10, 12, 9, 0, 0), T = NOW / 1000;
export const END_LINE = "Goal done · 2 h 14 min · 1.8M tokens · 7 cycles";
export const RUNS = [
  { id: "g1", name: "Find why the nightly export is slow and fix the slowest query", status: "blocked", started_at: T - 90000, ended_at: T - 86000, elapsed_seconds: 3120, tokens: 412000, cycles: 4 },
  { id: "g2", name: "Rename the watering helpers", status: "stopped", started_at: T - 40000, ended_at: T - 39955, elapsed_seconds: 45, tokens: 950, cycles: 1 },
  { id: "g3", name: "Move the upload limit into settings so each plan can have its own, with tests", status: "completed", started_at: T - 8100, ended_at: T - 2, elapsed_seconds: 8040, tokens: 1800000, cycles: 7 },
];
const turn = (id, at, prompt, reply) => [{ type: "turn_start", turn_id: id, prompt, kind: "prompt" }, { role: "time", of: "prompt", at },
  { role: "time", of: "trace", at: at + 4, tokens: 5200 }, { type: "tool_call", call_id: `c-${id}`, name: "read_file", args: {}, summary: "src/settings.py" },
  { role: "time", of: "trace", at: at + 5 }, { type: "tool_result", call_id: `c-${id}`, name: "read_file", output: "one\n", is_error: false },
  { type: "text_delta", text: reply }, { role: "time", of: "trace", at: at + 40, tokens: 900 }, { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
  { role: "time", of: "reply", at: at + 40 }, { type: "turn_end", turn_id: id, reason: "completed", final_message_id: `${id}:1` }];

/** The Work panel at `width`. list: also choose "/goal-history" and leave the Goals list open. */
export async function openGoals(browser, { width = 700, height = 760, theme = "dark-modern", list = false } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.addStyleTag({ content: traceCss });
  await page.evaluate(([t, mjs, mdjs, now, tjs]) => {
    document.body.classList.add(t.startsWith("light") ? "vscode-light" : t === "hc" ? "vscode-high-contrast" : "vscode-dark");
    window.__wall = now; Date.now = () => window.__wall;
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(tjs);
    eval(mjs);
  }, [theme, mainJs, markdownJs, NOW, traceJs]);
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200)))));
  const event = (ev) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), ev);
  await event({ type: "ready", capabilities: { goal_runs: true }, commands: [], custom_commands: [] });
  await event({ type: "config", model: "qwen3.8:27b", mode: "default", think: "off", base_url: "http://127.0.0.1:1/v1", project_root: "/p", goal: {} });
  await page.evaluate(() => window.dispatchEvent(new MessageEvent("message", { data: { type: "session_ready", sessionId: "s1" } })));
  await event({ type: "session", kind: "resumed", session_id: "s1" });
  await event({ type: "history", complete: true, items: [
    ...turn("h1", T - 8100, "Move the upload limit into settings so each plan can have its own, with tests.", "The limit now reads from settings. Next: the tests for a plan with no limit of its own."),
    ...turn("h2", T - 60, "Carry on with the goal.", "Done. The upload limit lives in settings, each plan can carry its own, the default stays at 20 a minute, and three new tests cover it.")] });
  await event({ type: "goal_runs", runs: RUNS });
  await settle();
  if (list) {
    await page.evaluate(() => { const input = document.getElementById("input"); input.focus(); });
    await page.keyboard.type("/goal-h");
    await page.keyboard.press("Enter");
    await event({ type: "goal_runs", runs: RUNS });
    await page.evaluate(() => { const pop = document.getElementById("rail-pop"); if (pop.hidden) document.querySelector('#rail-chips .rail-chip[data-kind="goalruns"]')?.click(); });
    await settle();
  }
  return { page, errors, event, settle, close: () => page.close() };
}

/** What is drawn, measured in the page: the end line, the Goals pill and (open) its list. */
export const measureGoals = (page) => page.evaluate(() => {
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (e) => { const g = ground(e), c = over(parse(getComputedStyle(e).color), g), [x, y] = [lum(c), lum(g)].sort((p, q) => q - p); return Math.round(((x + 0.05) / (y + 0.05)) * 100) / 100; };
  const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const width = document.documentElement.clientWidth;
  const line = document.querySelector("#log .goal-end"), before = line?.previousElementSibling, reply = before?.matches(".msg.dgc") ? before : before?.querySelector(".msg.dgc");
  const chip = document.querySelector('#rail-chips .rail-chip[data-kind="goalruns"]'), pop = document.getElementById("rail-pop");
  const rows = pop && !pop.hidden ? [...pop.querySelectorAll(".goal-run")].map((row) => { const name = row.querySelector(".goal-run-name"), facts = row.querySelector(".goal-run-facts"), trace = row.querySelector(".goal-run-trace"), p = box(pop);
    const inside = (e) => { const b = box(e); return b.left >= p.left - 0.5 && b.right <= p.right + 0.5; };
    return { name: name.textContent, facts: facts.textContent, nameCut: name.scrollWidth > name.clientWidth + 1 && !name.title, factsInside: inside(facts), nameInside: inside(name), trace: { word: trace.textContent.trim(), cut: trace.scrollWidth > trace.clientWidth + 1, inside: inside(trace), disabled: trace.disabled, ...box(trace) },
      overlap: box(trace).left < Math.max(box(name).right, 0) - 0.5 && box(trace).top < box(name).bottom - 0.5 && box(name).top < box(trace).bottom - 0.5 && box(trace).left < box(name).right - 0.5,
      ratios: [ratio(name), ratio(facts), ...(trace.disabled ? [] : [ratio(trace)])], ...box(row) }; }) : null;
  return { width, sideways: document.documentElement.scrollWidth - width,
    line: line ? { text: line.textContent.replace(/\s+/g, " ").trim(), ...box(line), ratio: ratio(line), underReply: !!reply?.classList.contains("dgc"), lines: Math.round(box(line).height / parseFloat(getComputedStyle(line).lineHeight || "18")) } : null,
    chip: chip ? { text: [...chip.querySelectorAll(".chip-word, .chip-num")].map((n) => n.textContent).join(" ").trim(), ...box(chip), ratio: ratio(chip.querySelector(".chip-word, .chip-num") || chip) } : null,
    pop: pop && !pop.hidden ? box(pop) : null, rows };
});
