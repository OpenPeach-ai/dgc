// A Work chat in which DGC changed its own settings when asked (dgc_settings; dgc/settings_tool.py): an ordinary
// setting, a permission rule and a Dev Mode limit, each result ending "Undo: setchg_…". Each draws as one quiet line
// with Undo. Shared by settings-undo.test.mjs (jsdom), settings-undo-layout.test.mjs (Chromium), one-shape-controls
// and render-settings-undo.mjs (the pictures). Not a *.test.mjs file.
import { THEMES, panelHtml } from "./options-scene.mjs";

/** The tool's own words (settings_tool.change / rule / dev_limit), each with the id its Undo takes. */
export const CHANGES = [
  { id: "setchg_1a2b3c4d5e6f7a8b", args: { action: "setting", key: "thinking", value: "high", reason: "think harder" },
    words: "Changed how much the model thinks before it answers (thinking): low → high" },
  { id: "setchg_2222222222222222", args: { action: "rule", rule_action: "allow", rule: "Bash(npm test:*)", reason: "run the tests without asking" },
    words: "Added Bash(npm test:*) to allow rules" },
  { id: "setchg_3333333333333333", args: { action: "dev_limit", key: "work_helpers", value: 12, reason: "more helpers" },
    words: "Changed the Dev Mode limit work_helpers: default → 12" },
];
export const said = (change) => `${change.words}. Undo: ${change.id}`;
export const call = (change, n = 1) => ({ type: "tool_call", call_id: `set-${n}`, name: "dgc_settings", args: change.args, summary: "" });
export const result = (change, n = 1) => ({ type: "tool_result", call_id: `set-${n}`, name: "dgc_settings", output: said(change),
  is_error: false, is_diff: false, diff: "" });
/** One finished turn: the three changes, then the reply. */
export function changesTurn(id = "t1", changes = CHANGES) {
  return [
    { type: "turn_start", turn_id: id, prompt: "Think harder, let the tests run without asking, and allow 12 helpers.", kind: "prompt" },
    ...changes.flatMap((change, i) => [call(change, i + 1), result(change, i + 1)]),
    { type: "text_delta", text: "Done: thinking is high now, npm test runs without asking, and up to 12 helpers can work at once." },
    { type: "stream_end", message_id: `${id}:1`, phase: "answer" },
    { type: "turn_end", turn_id: id, reason: "completed", token_estimate: 10, final_message_id: `${id}:1` },
  ];
}
export const READY = { type: "ready", capabilities: { settings_undo: 1 }, commands: [], custom_commands: [] };

/** The Work panel at `width` with the three lines: the first as it arrived, the second undone, the third one that
 *  could not be undone (its setting changed again since). `fresh`: all three as they arrived. */
export async function openSettingsChanges(browser, { width = 700, height = 760, theme = "dark-modern", fresh = false } = {}) {
  const { html, mainJs, markdownJs } = panelHtml();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
  const errors = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  await page.setContent(html, { waitUntil: "load" });
  await page.addStyleTag({ content: `:root { --vscode-font-family: system-ui, sans-serif; --vscode-editor-font-family: ui-monospace, monospace; ${THEMES[theme]} }` });
  await page.evaluate(([t, mjs, mdjs]) => {
    document.body.classList.add(t.startsWith("light") ? "vscode-light" : "vscode-dark");
    window.__posted = [];
    window.acquireVsCodeApi = () => ({ postMessage(m) { window.__posted.push(m); }, getState: () => undefined, setState() {} });
    eval(mdjs + "\nglobalThis.DgcMarkdown = DgcMarkdown;");
    eval(mjs);
  }, [theme, mainJs, markdownJs]);
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 200)))));
  const event = (ev) => page.evaluate((d) => window.dispatchEvent(new MessageEvent("message", { data: { type: "event", event: d } })), ev);
  await event(READY);
  await event({ type: "config", model: "qwen3.8:27b", mode: "auto", think: "off", base_url: "http://127.0.0.1:1/v1", project_root: "/p", goal: {} });
  for (const ev of changesTurn()) await event(ev);
  await settle();
  if (!fresh) {
    await page.click(`#log .setting-change[data-change-id="${CHANGES[1].id}"] button`);
    await event({ type: "setting_undone", request_id: "setting-undo-1", change_id: CHANGES[1].id, ok: true, said: "Undone." });
    await page.click(`#log .setting-change[data-change-id="${CHANGES[2].id}"] button`);
    await event({ type: "setting_undone", request_id: "setting-undo-2", change_id: CHANGES[2].id, ok: false, said: "work_helpers changed again since; nothing was undone." });
    await settle();
  }
  await page.mouse.move(2, 2);
  return { page, errors, event, settle, posted: () => page.evaluate(() => window.__posted), close: () => page.close() };
}

/** What is drawn, measured in the page: each line, its words, its Undo. */
export const measureLines = (page) => page.evaluate(() => {
  const parse = (c) => { const m = c.match(/-?[\d.]+(e-?\d+)?/g)?.map(Number) || [0, 0, 0, 0]; return c.startsWith("color(srgb") ? [m[0] * 255, m[1] * 255, m[2] * 255, m[3] ?? 1] : [m[0], m[1], m[2], m[3] ?? 1]; };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (e) => { const layers = []; for (let n = e; n; n = n.parentElement) { const c = parse(getComputedStyle(n).backgroundColor); if (c[3] > 0) layers.push(c); if (c[3] >= 1) break; }
    return layers.reduceRight((under, top) => over(top, under), [255, 255, 255, 1]); };
  const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((v) => { const x = v / 255; return x <= 0.04045 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const contrast = (e) => { const bg = ground(e), fg = over(parse(getComputedStyle(e).color), bg); const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x); return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100; };
  const box = (e) => { const r = e.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const probe = document.createElement("i"); probe.style.cssText = "position:absolute;visibility:hidden;height:var(--btn-h-sm);border-radius:var(--btn-r)"; document.body.append(probe);
  const family = { radius: parseFloat(getComputedStyle(probe).borderTopLeftRadius), height: probe.getBoundingClientRect().height }; probe.remove();
  const log = document.getElementById("log");
  const turn = log.querySelector(".setting-change")?.closest(".msg");
  return { family, log: box(log), turn: turn ? box(turn) : null, page: document.documentElement.clientWidth, sideways: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    lines: [...log.querySelectorAll(".setting-change")].map((line) => {
      const words = line.querySelector(".setting-change-words"), state = line.querySelector(".setting-change-said"), undo = line.querySelector("button");
      const first = (() => { const range = document.createRange(); range.selectNodeContents(words); const r = range.getClientRects()[0]; return { top: r.top, bottom: r.bottom }; })();
      return { state: line.dataset.state, text: line.textContent, box: box(line), words: { ...box(words), contrast: contrast(words), first },
        said: state && state.textContent ? { text: state.textContent, contrast: contrast(state) } : null,
        mark: line.querySelector(":scope > .ic") ? box(line.querySelector(":scope > .ic")) : null,
        undo: undo ? { ...box(undo), text: undo.textContent, contrast: contrast(undo), radius: parseFloat(getComputedStyle(undo).borderTopLeftRadius),
          line: parseFloat(getComputedStyle(undo).borderTopWidth), disabled: undo.disabled } : null };
    }) };
});
