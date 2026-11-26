// Render (26 Nov): the "needs you" pill of a Pip's chat as it is now, beside the queue's pill, closed and open, at 300
// and 440 px, dark and light. Pictures only, into the folder given as argv[2].
import { chromium } from "@playwright/test";
import { GST, openOnePips } from "./support/one-pips-scene.mjs";
const out = process.argv[2];
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const scene = { fix: "ask", more: 2, posts: true, chat: { [GST]: { messages: [], waiting: [{ id: "msg_" + "7".repeat(32), text: "Also look at March", created_at: new Date().toISOString() }] } } };
for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 440]) {
  const x = await openOnePips(browser, { width, height: 760, theme, scene, scale: 2 });
  await x.openPip(GST); await x.waitIn('#chat-tray .rail-chip[data-kind="needs"]'); await x.page.waitForTimeout(400);
  const box = await x.inPips((root) => { const f = root.getElementById("chat-form"), r = f.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; });
  await x.page.screenshot({ path: `${out}/now-${theme}-${width}.png`, clip: { x: 0, y: Math.max(0, box.y - 70), width, height: box.h + 80 } });
  await x.click('#chat-tray .rail-chip[data-kind="needs"]'); await x.page.waitForTimeout(500);
  await x.page.screenshot({ path: `${out}/now-open-${theme}-${width}.png`, clip: { x: 0, y: 0, width, height: 760 } });
  await x.close();
}
await browser.close();
console.log("done");
