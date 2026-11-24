// Pictures of the artifact panel's fixes from the second user test (A3, A4): node test/render-ut2b-artifacts.mjs <out dir>
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openPanel } from "./support/artifact-scene.mjs";
const out = process.argv[2] || "/tmp/ut2b-shots"; mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const ON = { comments: true, compare: true }, AT = "2026-11-22T10:00:00Z";
const THREAD = { id: "t_111111111111", version: 2, status: "open", at: AT, by: "you", answering: false, found: "here",
  anchor: { kind: "slide", slide: 1, field: "slide", title: "Q3 plan" }, where: "slide 1",
  messages: [{ id: "m_a", by: "you", at: AT, text: "Make this title punchier, max 5 words.", kind: "comment" },
             { id: "m_b", by: "DGC", at: AT, text: "I shortened the title of slide 1; the notes are unchanged.", kind: "answer" }], suggestions: [] };
for (const theme of ["dark-modern", "light-modern"]) for (const width of [300, 545, 700]) {
  const tag = `${theme.split("-")[0]}-${width}`;
  let s = await openPanel(browser, { kind: "slides", width, height: 800, theme, offer: ON });
  await s.send({ type: "comments", id: s.data.view.id, version: s.data.view.version, threads: [THREAD] });
  await s.page.waitForTimeout(500);
  await s.page.screenshot({ path: join(out, `a4-slides-comments-${tag}.png`) });
  await s.page.click("#art-versions"); await s.page.waitForTimeout(200);
  await s.page.screenshot({ path: join(out, `a3-versions-${tag}.png`) });
  await s.page.close();
  s = await openPanel(browser, { kind: "slides", width, height: 800, theme, offer: ON });
  await s.send({ type: "comments", id: s.data.view.id, version: s.data.view.version, threads: [] });
  await s.page.locator(".sl-comment").click(); await s.page.waitForTimeout(300);
  await s.page.screenshot({ path: join(out, `a3-comment-box-${tag}.png`) });
  await s.page.close();
}
await browser.close();
