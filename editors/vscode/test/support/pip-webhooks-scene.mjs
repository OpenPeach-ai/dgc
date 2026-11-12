// The webhook screens (pips-22, Pips API 90) opened in the Pip chat scene: a routine's panel under its card, and Pips
// settings at Webhooks. Shared by pip-webhooks-browser.test.mjs and the pictures (render-webhooks.mjs). Not a test file.
import { openChat } from "./pip-chat-scene.mjs";

export async function openPanel(b, { width, theme, webhooks = { network: true, tunnel: "own", longBase: true }, height = 1100, ...rest }) {
  const x = await openChat(b, { width, height, theme, api: 90, settings: true, webhooks, ...rest });
  await x.p.evaluate(() => (window.__pipsRoot || document).querySelector('[data-tab="job"]').click());
  await x.p.waitForSelector("[data-routine-edit]");
  await x.p.evaluate(() => [...(window.__pipsRoot || document).querySelectorAll("[data-routine-edit]")].find((b) => /New payments/.test(b.textContent)).click());
  await x.p.waitForSelector("[data-webhook-panel] .webhook-address");
  await x.p.evaluate(() => (window.__pipsRoot || document).querySelector("[data-webhook-panel]").scrollIntoView({ block: "start" }));
  await x.p.waitForTimeout(150);
  return x;
}
export async function openReach(b, { width, theme, webhooks = {}, height = 900, ...rest }) {
  const x = await openChat(b, { width, height, theme, api: 90, settings: true, webhooks, home: true, ...rest });
  await x.p.click("#pips-settings-open");
  await x.p.click('[data-pips-settings="webhooks"]');
  await x.p.waitForSelector(".webhook-reach .webhook-internet");
  await x.p.waitForTimeout(150);
  return x;
}
