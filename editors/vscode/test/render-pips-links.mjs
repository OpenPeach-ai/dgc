// Pictures of links in a Pip's chat and in ChatDGC, and of a Pip's chat in an editor tab (0.52, 15 Nov): the real pages
// in real Chromium on the stand-in DGC (test/support/pip-chat-scene.mjs, test/support/chat-scene.mjs), dark and light,
// at 300, 440 and 700 px. The icon service is a stand-in too: nothing is asked of the network. Not a test. Run:
//   PLAYWRIGHT_BROWSERS_PATH=~/.cache/ms-playwright node test/render-pips-links.mjs <out-dir> [name-filter]
import { mkdirSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { chromium } from "@playwright/test";
import { PIP, openChat } from "./support/pip-chat-scene.mjs";
import { M, conversation, openChat as openChatDgc } from "./support/chat-scene.mjs";

const out = process.argv[2] || "pips-links-pictures", only = process.argv[3] || "";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });

// A site's icon, as the icon service would send one: a small flat picture in the site's colour.
function png(rgb, size = 32) {
  const crc = (buf) => { let c, n = ~0; for (const b of buf) { c = (n ^ b) & 255; for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1; n = (n >>> 8) ^ c; } return ~n >>> 0; };
  const chunk = (type, data) => { const head = Buffer.alloc(4); head.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(body)); return Buffer.concat([head, body, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) { const dx = x - size / 2 + 0.5, dy = y - size / 2 + 0.5, inside = Math.hypot(dx, dy) <= size / 2 - 1, at = y * (size * 4 + 1) + 1 + x * 4;
    rows[at] = rgb[0]; rows[at + 1] = rgb[1]; rows[at + 2] = rgb[2]; rows[at + 3] = inside ? 255 : 0; }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}
const ICONS = { "vibedgc.com": png([124, 92, 255]), "github.com": png([36, 41, 47]), "news.example": png([214, 96, 44]), "stay.example": png([32, 150, 110]) };
const icon = (url) => ICONS[decodeURIComponent(new URL(url).searchParams.get("domain") || "").replace(/^https?:\/\//, "")] || png([120, 120, 120]);

const LINK = "https://vibedgc.com/pricing?ref=chat";
const SAID = [{ role: "user", text: "Read https://vibedgc.com/pricing?ref=chat and https://github.com/openai/codex. Which is cheaper for five people?" },
  { role: "assistant", text: "Both read. For five people [the pricing page](https://vibedgc.com/pricing?ref=chat) comes to less than what [the repository](https://github.com/openai/codex) says its hosted plan costs.\n\nThe numbers are from today's pages." }];
const cid = (c) => "conv_" + c.repeat(32);
const toEnd = () => { const log = (window.__pipsRoot || document).querySelector(".conversation-log"); let n = log; while (n && n.scrollHeight <= n.clientHeight + 1) n = n.parentElement; if (n) n.scrollTop = n.scrollHeight; };
const paste = (p, sel, text) => p.evaluate(([s, words]) => { const box = (window.__pipsRoot || document).querySelector(s); box.focus(); const data = new DataTransfer(); data.setData("text/plain", words);
  box.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true, composed: true })); }, [sel, text]);
const type = (p, sel, text) => p.evaluate(([s, words]) => { (window.__pipsRoot || document).querySelector(s).focus(); document.execCommand("insertText", false, words); }, [sel, text]);

const base = { api: 97, convs: true, switches: true, codicon: true, scale: 1 };
const PIPS = {
  // The box with a pasted link: words, then one link pasted, is a pill.
  "pip-box": { scene: {}, after: async (p) => { await type(p, "#chatText", "Summarise "); await paste(p, "#chatText", LINK); } },
  // A sent message with links and a reply with links, favicons on; the header with its controls above them.
  "pip-chat-favicons-on": { scene: { convs: false, said: SAID, icons: "answer" }, after: async (p) => { await p.evaluate(toEnd); } },
  // The same with dgc.linkFavicons off: each link its bundled mark, nothing asked.
  "pip-chat-favicons-off": { scene: { convs: false, said: SAID, favicons: "off", icons: "answer" }, after: async (p) => { await p.evaluate(toEnd); } },
  // An icon service that cannot be reached: the bundled mark comes back.
  "pip-chat-favicons-failed": { scene: { convs: false, said: SAID, icons: "refuse" }, after: async (p) => { await p.waitForTimeout(500); await p.evaluate(toEnd); }, widths: [700] },
  // The header's menu open: Open in editor, its first row.
  "pip-menu-open": { scene: {}, after: async (p) => { await p.click(".pip-topbar .pip-menu > summary"); } },
  // The header's icon pointed at (from 700 px).
  "pip-header-icon": { scene: {}, after: async (p) => { await p.hover("#pip-open-editor"); await p.waitForTimeout(700); }, widths: [700] },
  // A conversation's own editor tab.
  "pip-editor-tab": { scene: { pinned: { pip: PIP, conversation: cid("a") } }, where: "tab", after: async (p) => { await p.waitForFunction(() => /Bhakti Kutir is held/.test(document.querySelector(".conversation-log")?.textContent || "")); } },
  // A Pip's row in the list, pointed at: Open in editor beside its pin.
  "pip-row": { scene: { home: true }, after: async (p) => { await p.evaluate(() => window.postMessage({ type: "dock", pinned: ["work:another"] }, "*")); await p.waitForTimeout(200); await p.hover(`[data-job="${PIP}"]`);
    // (At 340 px and under the row keeps its room for the Pip's name: no Open in editor there.)
    if (await p.locator(`[data-open-pip-chat="${PIP}"]`).isVisible()) await p.hover(`[data-open-pip-chat="${PIP}"]`); await p.waitForTimeout(700); }, widths: [300, 440], height: 420 },
};
async function pip(name, theme, width) {
  const file = `${name}-${theme}-${width}`;
  if (only && !file.includes(only)) return;
  const shot = PIPS[name];
  if (shot.widths && !shot.widths.includes(width)) return;
  const x = await openChat(browser, { ...base, width, height: shot.height || 660, theme, where: shot.where || (width >= 700 ? "tab" : "side"), ...shot.scene, icons: shot.scene.icons === "refuse" ? "refuse" : icon });
  try {
    if (shot.scene.said) { await x.p.evaluate(() => window.postMessage({ type: "pipsUnreadChanged" }, "*")); }
    await x.p.waitForTimeout(350);
    await x.p.mouse.move(1, (shot.height || 660) / 2);   // (the pointer rests on nothing)
    await shot.after(x.p); await x.p.waitForTimeout(350);
    await x.p.screenshot({ path: `${out}/${file}.png` });
    console.log(file, x.errors.length ? x.errors : "ok");
  } finally { await x.close(); }
}

const CHAT = {
  "chatdgc-box": { messages: [], after: async (s) => { await type(s.page, "#cd-input", "Summarise "); await paste(s.page, "#cd-input", LINK); } },
  "chatdgc-sent": { messages: [{ id: M(1), role: "user", text: SAID[0].text, created_at: "2026-11-15T09:20:00Z" }, { id: M(2), role: "assistant", text: SAID[1].text, finish: "stop", created_at: "2026-11-15T09:20:05Z" }], after: async () => {} },
  "chatdgc-sent-favicons-off": { messages: [{ id: M(1), role: "user", text: SAID[0].text, created_at: "2026-11-15T09:20:00Z" }, { id: M(2), role: "assistant", text: SAID[1].text, finish: "stop", created_at: "2026-11-15T09:20:05Z" }], off: true, after: async () => {}, widths: [440] },
};
async function chat(name, theme, width) {
  const file = `${name}-${theme}-${width}`;
  if (only && !file.includes(only)) return;
  const shot = CHAT[name];
  if (shot.widths && !shot.widths.includes(width)) return;
  const s = await openChatDgc(browser, { width, height: 560, theme: theme === "light" ? "light-modern" : "dark-modern", scale: 1 });
  try {
    await s.page.route("https://www.google.com/**", (route) => route.fulfill({ contentType: "image/png", body: icon(route.request().url()) }));
    await s.send({ type: "opened", conversation: conversation(), messages: shot.messages, earlier: 0, busy: false });
    await s.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud"], current: "deepseek-v4.1-flash:cloud" });
    await s.send({ type: "favicons", on: !shot.off });
    await s.page.waitForTimeout(400);
    await shot.after(s); await s.page.waitForTimeout(400);
    await s.page.screenshot({ path: `${out}/${file}.png` });
    console.log(file, s.errors.length ? s.errors : "ok");
  } finally { await s.page.close(); }
}
for (const theme of ["dark", "light"]) for (const width of [300, 440, 700]) {
  for (const name of Object.keys(PIPS)) await pip(name, theme, width);
  for (const name of Object.keys(CHAT)) await chat(name, theme, width);
}
await browser.close();
