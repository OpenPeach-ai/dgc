// Pictures of a Pip's chat with the messages it read on the way where it read them, the same while it works, its
// thinking slider beside Work's at every stop with two Pips' faces, and its prompt box naming its model (0.52, 15 Nov).
// The side bar's real page with the real Pips view on the stand-in DGC, dark and light, at 300, 440 and 700 px.
// Not a test. Run:
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-pip-steer.mjs <out-dir> [name-filter]
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";
import { GST, MORNINGS, openOnePips } from "./support/one-pips-scene.mjs";
import { openMapScene } from "./support/agent-map-scene.mjs";
import { modelsMessage } from "./support/model-menu-scene.mjs";

const out = process.argv[2] || "pip-steer-pictures", only = process.argv[3] || "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const RUN = "run_" + "7".repeat(32), MODEL = "deepseek-v4.1-flash:cloud";
const ONE = "I read the notes from Monday's call and started the summary. The first part covers what was agreed about the delivery dates.";
const TWO = "The shorter title is in: **Delivery dates, agreed**. Now the totals for each week.";
const THREE = "Done. The summary has the shorter title and no totals table:\n\n- Week 1: tiles for the two bathrooms\n- Week 2: the kitchen floor\n\nTell me if the dates should move.";
const asked = (status) => ({ id: "u1", role: "user", text: "Write the summary of Monday's call", run_id: RUN, status });
const late = (id, text) => ({ id, role: "user", text, run_id: RUN, status: "succeeded", steered: true, steer_status: "applied" });
const words = (text) => ({ event_type: "pip_run_progress", payload: { kind: "text_delta", text } });
const doing = (message) => ({ event_type: "pip_run_progress", payload: { kind: "progress", state: "tool", message } });
const DONE = { messages: [asked("succeeded"), late("s1", "Use the shorter title"), late("s2", "Leave the totals table out"),
  { id: "a1", role: "assistant", text: [ONE, TWO, THREE].join("\n\n"), run_id: RUN, status: "succeeded", steers: [{ id: "s1", at: ONE.length }, { id: "s2", at: ONE.length + 2 + TWO.length }] }], active_run: null };
const toEnd = (root) => { const log = root.querySelector(".conversation-log"); let n = log; while (n && n.scrollHeight <= n.clientHeight + 1) n = n.parentElement; if (n) n.scrollTop = n.scrollHeight; };
const THEMES = [["dark", "dark-modern"], ["light", "light-modern"]], WIDTHS = [300, 440, 700];
const want = (name) => !only || name.includes(only);
const push = (x, event) => x.page.evaluate(([run, e]) => { window.__backend.state.activity[run].push(e); }, [RUN, event]);
const has = (x, text) => x.page.waitForFunction((t) => [...document.getElementById("pips-host").shadowRoot.querySelectorAll(".conversation-log .message-body, .conversation-log .prompt-text")].some((n) => n.textContent.includes(t)), text, { polling: 50 });
const say = async (x, text) => { await x.page.locator("#chatText").fill(text); await x.page.locator("#chatText").press("Enter"); await has(x, text); };

for (const [tone, theme] of THEMES) for (const width of WIDTHS) {
  // 1. A finished reply that read two messages.
  if (want(`done-${tone}-${width}`)) {
    const x = await openOnePips(browser, { api: 99, width, height: 900, theme, faces: true, scale: 2, scene: { sub: true, waiting: false, model: MODEL, chat: { [GST]: DONE } } });
    try { await x.openPip(GST); await x.page.waitForTimeout(400); await x.inPips(toEnd); await x.page.waitForTimeout(150);
      await x.page.screenshot({ path: `${out}/done-${tone}-${width}.png` }); console.log(`done-${tone}-${width}`, x.errors.length ? x.errors : "ok"); } finally { await x.close(); }
  }
  // 2. The same while it works: each message sent as its words were on screen, the words carrying on below.
  if (want(`live-${tone}-${width}`)) {
    const x = await openOnePips(browser, { api: 99, width, height: 900, theme, faces: true, scale: 2, scene: { sub: true, waiting: false, model: MODEL,
      chat: { [GST]: { messages: [asked("running")], active_run: { id: RUN, status: "running", run_kind: "conversation", started_at: new Date(Date.now() - 41000).toISOString() } } }, activity: { [RUN]: [words(ONE)] } } });
    try { await x.openPip(GST); await has(x, "delivery dates");
      await say(x, "Use the shorter title"); await push(x, words(`\n\n${TWO}`)); await has(x, "totals for each week");
      await say(x, "Leave the totals table out"); await push(x, words("\n\nDone. The summary has the shorter title and no totals")); await push(x, doing("Reading the notes")); await has(x, "no totals");
      await x.page.waitForTimeout(500); await x.inPips(toEnd); await x.page.waitForTimeout(150);
      await x.page.screenshot({ path: `${out}/live-${tone}-${width}.png` }); console.log(`live-${tone}-${width}`, x.errors.length ? x.errors : "ok"); } finally { await x.close(); }
  }
  // 3. The slider at each stop: Work's, and two Pips' with their own faces. One sheet per theme and width.
  if (want(`slider-${tone}-${width}`)) {
    const shots = [];
    const s = await openMapScene(browser, { width, height: 760, theme, open: false, capabilities: { agents_model: 1, model_fallback: 1 } });
    try { await s.page.click("#btn-model"); await s.post(modelsMessage()); await s.page.waitForSelector("#modelmenu .effort-slider"); await s.page.waitForTimeout(250);
      for (let stop = 0; stop <= 5; stop++) { await s.page.evaluate((v) => { const sl = document.querySelector("#modelmenu .effort-slider"); sl.value = String(v); sl.dispatchEvent(new Event("input", { bubbles: true })); }, stop); await s.page.waitForTimeout(350);
        shots.push(["Work", stop, (await s.page.locator("#modelmenu .effort-control").screenshot()).toString("base64")]); }
    } finally { await s.page.context().close(); }
    for (const [name, pip] of [["Tile checker", GST], ["Mornings", MORNINGS]]) {
      const x = await openOnePips(browser, { api: 99, width, height: 760, theme, faces: true, scale: 2, scene: { sub: true, waiting: false, model: MODEL } });
      try { await x.openPip(pip); await x.waitIn("#chat-model:not([disabled])"); await x.click("#chat-model"); await x.waitIn("#chat-thinking"); await x.page.waitForTimeout(400);
        for (let stop = 0; stop <= 5; stop++) { await x.inPips((root, v) => { const sl = root.querySelector("#chat-thinking"); sl.value = String(v); sl.dispatchEvent(new Event("input", { bubbles: true, composed: true })); }, stop); await x.page.waitForTimeout(350);
          shots.push([name, stop, (await x.page.locator(".effort-control").screenshot()).toString("base64")]); }
        if (name === "Tile checker") { await x.inPips((root) => root.querySelector("#chat-thinking").focus()); await x.page.keyboard.press("ArrowLeft"); await x.page.waitForTimeout(400);
          shots.push([`${name}, by keyboard`, 4, (await x.page.locator(".effort-control").screenshot()).toString("base64")]);
          await x.page.screenshot({ path: `${out}/menu-${tone}-${width}.png` }); }
        console.log(`slider-${tone}-${width} ${name}`, x.errors.length ? x.errors : "ok");
      } finally { await x.close(); }
    }
    const page = await browser.newPage({ viewport: { width: 1000, height: 400 }, deviceScaleFactor: 1 });
    const bg = tone === "dark" ? "#1f1f1f" : "#ffffff", fg = tone === "dark" ? "#ccc" : "#333";
    const rows = [...new Set(shots.map((r) => r[0]))];
    await page.setContent(`<body style="margin:0;padding:16px;background:${bg};color:${fg};font:12px system-ui"><h3 style="margin:0 0 12px">Thinking slider, ${tone}, side bar ${width}px: Work's, then each Pip's</h3>${rows.map((row) => `<div style="margin:0 0 14px"><div style="margin:0 0 4px">${row}</div><div style="display:flex;flex-wrap:wrap;gap:10px">${shots.filter((r) => r[0] === row).map((r) => `<figure style="margin:0"><img style="zoom:.5" src="data:image/png;base64,${r[2]}"><figcaption style="opacity:.7">stop ${r[1]}</figcaption></figure>`).join("")}</div></div>`).join("")}</body>`);
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${out}/slider-${tone}-${width}.png`, fullPage: true }); await page.close();
  }
  // 4. The prompt box names its model, cut to fit.
  if (want(`model-${tone}-${width}`)) {
    const x = await openOnePips(browser, { api: 99, width, height: 700, theme, faces: true, scale: 2, scene: { sub: true, waiting: false, model: MODEL } });
    try { await x.openPip(GST); await x.page.waitForTimeout(400);
      const box = await x.inPips((root) => { const b = root.querySelector(".pip-composer-shell").getBoundingClientRect(); return { x: 0, y: Math.max(0, b.top - 12), width: document.documentElement.clientWidth, height: Math.min(innerHeight - Math.max(0, b.top - 12), b.height + 40) }; });
      await x.page.screenshot({ path: `${out}/model-${tone}-${width}.png`, clip: box }); console.log(`model-${tone}-${width}`, x.errors.length ? x.errors : "ok"); } finally { await x.close(); }
  }
}
await browser.close();
