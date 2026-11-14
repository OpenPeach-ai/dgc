// Pictures of a Pip's chat as a conversation, with its sub-agents (0.52, Pips API 97): the side bar's real page with
// the real Pips view, on the stand-in DGC (test/support/one-pips-scene.mjs, `sub: true`), dark and light, at 300, 440
// and 700 px, with a mouse and on touch. Not a test. Run:
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-pip-chat.mjs <out-dir> [name-filter]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";

const out = process.argv[2] || "pip-chat-pictures", only = process.argv[3] || "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const STAGES = {
  "1-ask": { scene: { fix: "ask" } },
  "2-working": { scene: { fix: "running", talk: true, earlier: 2 } },
  "2b-sent-back": { scene: { fix: "retry" } },
  "2c-steps": { scene: { fix: "running" }, after: async (x) => { await x.click(".pip-agent-row [data-agent-steps]"); } },
  "3-agent-map": { scene: { fix: "running", talk: true, earlier: 2 }, after: async (x) => { await x.click("#chat-agents"); await x.waitIn(".pip-agent-map"); await x.click(".pip-agent-map [data-agent-earlier]"); } },
  "3b-agent-card": { scene: { fix: "running", talk: true, earlier: 2 }, after: async (x) => { await x.click("#chat-agents"); await x.waitIn(".pip-agent-map"); await x.click(".pip-agent-map .am-agent"); await x.waitIn(".pip-agent-card"); } },
  "4-done-apply": { scene: { fix: "ready", tries: 2 } },
  "4b-discard-menu": { scene: { fix: "ready" }, after: async (x) => { await x.click(".pip-change [data-change-menu]"); } },
  "4c-do-it-all": { scene: { fix: "applied", level: "full" } },
  "5-held": { scene: { fix: "held" } },
  "6-asked": { scene: { fix: "asked" } },
  "7-failed": { scene: { fix: "failed" } },
  "8-not-now": { scene: { fix: "declined" } },
};
const toEnd = (root) => { const log = root.querySelector(".conversation-log"); let n = log; while (n && n.scrollHeight <= n.clientHeight + 1) n = n.parentElement; if (n) n.scrollTop = n.scrollHeight; };
async function shot(stage, { theme, width, touch = false }) {
  const name = `${stage}-${theme.startsWith("light") ? "light" : "dark"}-${width}${touch ? "-touch" : ""}`;
  if (only && !name.includes(only)) return;
  const s = STAGES[stage];
  const x = await openOnePips(browser, { api: 97, width, height: width === 300 ? 900 : 860, theme, touch, faces: true, scale: 2, scene: { sub: true, waiting: false, ...s.scene } });
  try {
    await x.openPip(GST); await x.page.waitForTimeout(350);
    await x.inPips(toEnd);
    if (s.after) { await s.after(x); await x.page.waitForTimeout(250); }
    await x.page.waitForTimeout(150);
    await x.page.screenshot({ path: `${out}/${name}.png` });
    console.log(name, x.errors.length ? x.errors : "ok");
  } finally { await x.close(); }
}
for (const stage of Object.keys(STAGES)) {
  await shot(stage, { theme: "dark-modern", width: 440 });
  await shot(stage, { theme: "light-modern", width: 440 });
}
for (const stage of ["1-ask", "2-working", "3-agent-map", "3b-agent-card", "4-done-apply", "6-asked"]) {
  for (const theme of ["dark-modern", "light-modern"]) { await shot(stage, { theme, width: 300 }); await shot(stage, { theme, width: 700 }); }
  await shot(stage, { theme: "dark-modern", width: 440, touch: true });
}
await browser.close();
