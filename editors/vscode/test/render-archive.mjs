// Pictures of Archive for Work sessions (0.52), dark and light, at 700 and 300 px: a row's "…" with Archive, the
// "Archived “…”. Undo" line, and View all with "Archived (N)" open (a row pointed at: Restore and Delete); then the
// Chat page's: a chat's "…" with Archive, its Undo line, and its "Archived (N)" open.
//   PLAYWRIGHT_BROWSERS_PATH=… node test/render-archive.mjs [OUT_DIR]
import { mkdirSync } from "node:fs";
import { chromium } from "@playwright/test";
import { CHATS, manySessions, openHome, SESSIONS } from "./support/home-scene.mjs";

const out = process.argv[2] || "archive-shots";
mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const settle = (page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 300)))));
const ARCHIVED = [
  { id: "20261101-120000-e5", name: "Checkout", preview: "", when: "2026-11-01 12:00", count: 14 },
  { id: "20261028-090000-f6", name: "", preview: "Why does the cart forget its coupon?", when: "2026-10-28 09:00", count: 6 },
  { id: "20261015-090000-g7", name: "A much longer name for an archived session, to see where it is cut at this width", preview: "", when: "2026-10-15 09:00", count: 40 },
];
const OLD_CHATS = [{ id: "chat_8", title: "Old trip to Hampi", preview: "Two days is enough.", updated_at: "2026-10-01T09:00:00Z", archived: true },
  { id: "chat_9", title: "Which kettle", preview: "The 1.5 litre one.", updated_at: "2026-09-01T09:00:00Z", archived: true },
  { id: "chat_7", title: "A much longer name for an archived chat, to see where it is cut at this width", preview: "", updated_at: "2026-08-01T09:00:00Z", archived: true }];
const problems = [];
for (const theme of ["dark", "light"]) for (const width of [700, 300]) {
  const shot = async (x, name) => { await settle(x.page); await x.page.screenshot({ path: `${out}/${name}-${theme}-${width}.png` }); console.log(`${out}/${name}-${theme}-${width}.png`); if (x.errors.length) problems.push(`${name} ${theme} ${width}: ${x.errors.join("; ")}`); };
  // 1. The "…" menu with Archive.
  let x = await openHome(browser, { width, height: 760, theme: `${theme}-modern`, tab: "work" });
  await x.send({ type: "sessions_list", items: SESSIONS, error: "", searchable: true, query: "", archive: true, archived: { items: ARCHIVED, more: false } });
  await x.page.hover("#sessions-list .session-row:nth-child(2)");
  await x.page.click("#sessions-list .session-row:nth-child(2) .session-more");
  await shot(x, "menu-archive");
  await x.page.keyboard.press("Escape");
  // 2. The Undo line.
  await x.page.mouse.move(5, 700);
  await x.send({ type: "sessions_list", items: SESSIONS.filter((s, i) => i !== 1), error: "", searchable: true, query: "", archive: true, archived: { items: [{ ...SESSIONS[1] }, ...ARCHIVED], more: false } });
  await x.send({ type: "sessions_note", kind: "archived", id: SESSIONS[1].id, title: "Visits page alignment" });
  await shot(x, "undo-line");
  await x.close();
  // 3. View all, with Archived open, a row pointed at.
  x = await openHome(browser, { width, height: 760, theme: `${theme}-modern`, tab: "work", sessions: manySessions(9) });
  await x.send({ type: "sessions_list", items: manySessions(9), error: "", searchable: true, query: "", archive: true, archived: { items: ARCHIVED, more: false } });
  await x.page.click("#sessions-all");
  await x.page.click("#sessions-archived-toggle");
  await x.page.locator("#sessions-archived .session-row").last().scrollIntoViewIfNeeded();
  await x.page.mouse.move(5, 5);
  await shot(x, "archived-open");
  await x.page.hover("#sessions-archived .session-row:nth-child(1)");
  await shot(x, "archived-open-row-pointed");
  await x.close();
  // 4. Chat: a chat's "…", the Undo line, and Archived open.
  x = await openHome(browser, { width, height: 760, theme: `${theme}-modern`, tab: "chat" });
  await x.send({ type: "chatdgc_archived", items: OLD_CHATS, total: 3, more: false });
  await x.page.hover("#chats-list .chat-row:nth-child(2)");
  await x.page.click("#chats-list .chat-row:nth-child(2) .session-more");
  await shot(x, "chat-menu-archive");
  await x.page.keyboard.press("Escape");
  await x.page.mouse.move(5, 700);
  await x.send({ type: "chatdgc_list", available: true, items: CHATS.slice(0, 1), open: ["chat_1"] });
  await x.send({ type: "chatdgc_archived", items: [{ ...CHATS[1], archived: true }, ...OLD_CHATS], total: 4, more: false });
  await x.send({ type: "chatdgc_note", kind: "archived", id: "chat_2", title: CHATS[1].title });
  await x.page.click("#chats-archived-toggle");
  await x.page.mouse.move(5, 700);
  await shot(x, "chat-undo-line-archived-open");
  await x.page.hover("#chats-archived .session-row:nth-child(2)");
  await shot(x, "chat-archived-open-row-pointed");
  await x.close();
}
await browser.close();
if (problems.length) { console.error(problems.join("\n")); process.exit(1); }
