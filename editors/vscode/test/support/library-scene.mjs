// The side bar's Library tab (0.52, 15 Nov): the real side bar (dock-scene.mjs opens it) on its Library tab, with a
// stand-in for the host that answers what the page asks through "sideLibrary" the way src/chatdgc.ts does (the same
// messages the full Library's page hears): the artifacts with who made each, ChatDGC's files, Work's images.
// Shared by library-tab-browser.test.mjs, the narrowest-words walk and the pictures. Not a *.test.mjs file.
import { openDock, pipId } from "./dock-scene.mjs";
import { SESSIONS, CHATS } from "./home-scene.mjs";

const ar = (n) => "ar_" + String(n).repeat(16).slice(0, 16);
const ago = (minutes) => new Date(Date.now() - minutes * 60000).toISOString();
const A = (n, type, title, minutes, origin, made_by, more = {}) => ({ id: ar(n), type, label: { page: "Page", doc: "Document", slides: "Slides", sheet: "Sheet", dashboard: "Dashboard" }[type], title, version: 1 + (n % 3),
  created: ago(minutes + 600), updated: ago(minutes), origin, made_by, exports: type === "sheet" ? ["xlsx", "csv"] : ["html"], ...more });
export const TILE = pipId("b"), MORNING = pipId("c");
export const SESSION = SESSIONS[1].id, CHAT = CHATS[1].id;
/** Nine artifacts: every type, made by two Pips, a session, two chats, an unnamed session and the terminal; two of
 *  the Pages were made by a widget and by a card. */
export const LIB_ARTIFACTS = [
  A(1, "page", "Tide pool walk, Saturday", 40, { surface: "pip", pip: TILE }, { kind: "pip", id: TILE, name: "Tile checker" }),
  A(2, "sheet", "Acme sales sheet", 130, { surface: "work", session: SESSION }, { kind: "session", id: SESSION, name: "Fix totals" }),
  A(3, "doc", "Launch notes", 60 * 26, { surface: "chat", chat: CHAT }, { kind: "chat", id: CHAT, name: "Rent or buy: the numbers" }, { file: "/home/me/.dgc/artifacts/" + ar(3) + "/work/Launch notes.md" }),
  A(4, "slides", "Q3 plan", 60 * 24 * 3, { surface: "chat", chat: CHATS[0].id }, { kind: "chat", id: CHATS[0].id, name: "A week in Goa in March" }),
  A(5, "dashboard", "Store sales", 60 * 24 * 9, { surface: "pip", pip: MORNING }, { kind: "pip", id: MORNING, name: "Morning brief" }),
  A(6, "page", "Weekly signups", 60 * 5, { surface: "chat", chat: CHAT }, { kind: "chat", id: CHAT, name: "Rent or buy: the numbers" }, { made_as: "widget" }),
  A(7, "page", "Open invoices by month", 15, { surface: "pip", pip: TILE }, { kind: "pip", id: TILE, name: "Tile checker" }, { made_as: "card" }),
  A(8, "page", "Tip calculator", 60 * 24 * 40, { surface: "work", session: "" }, { kind: "session", id: "", name: "" }),
  A(9, "page", "A page with a name so long that it cannot fit on one line of a narrow side bar, whatever the width", 60 * 24 * 100, { surface: "cli" }, { kind: "cli", id: "", name: "" }),
];
const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAGUlEQVQYlWP8z8Dwn4EIwESMolGF1FMIAD2cAg7lhN7pAAAAAElFTkSuQmCC";
export const LIB_FILES = [
  { source: "chat", chat_id: CHATS[0].id, id: "att_" + "3".repeat(32), name: "Beach map.png", kind: "image", type: "image", mime: "image/png", size: 48213, created_at: ago(90), chat_title: "A week in Goa in March", made: true },
  { source: "chat", chat_id: CHAT, id: "att_" + "4".repeat(32), name: "Billing review.pdf", kind: "document", type: "pdf", mime: "application/pdf", size: 918213, created_at: ago(60 * 30), chat_title: "Rent or buy: the numbers", made: false },
  { source: "project", project_id: "project_" + "a".repeat(32), project_name: "Goa trip", id: "att_" + "5".repeat(32), name: "ferry-times.csv", kind: "document", type: "spreadsheet", size: 2210, created_at: ago(60 * 24 * 5) },
];
export const LIB_IMAGES = [
  { path: "/home/me/shop/assets/hero-tiles.png", rel: "assets/hero-tiles.png", prompt: "A wall of lime green tiles in morning light", generator_name: "Images", model: "", project: "/home/me/shop", created_at: ago(200), width: 1024, height: 768, bytes: 381200 },
];

/** Opens the side bar on its Library tab. artifacts/files/images: what the host lists (null for artifacts: this DGC
 *  offers none); everything else is dock-scene's. Returns its helpers plus lib() (the page as drawn) and said(type)
 *  (what the page asked the host through "sideLibrary"). */
export async function openLibraryTab(browser, { artifacts = LIB_ARTIFACTS, files = LIB_FILES, images = LIB_IMAGES, tab = "library", ...rest } = {}) {
  const x = await openDock(browser, { tab, height: 760, ...rest });
  await x.page.evaluate(({ artifacts, files, images, PNG }) => {
    const say = (message) => window.dispatchEvent(new MessageEvent("message", { data: { type: "sideLibrary", message: JSON.parse(JSON.stringify(message)) } }));
    const lib = window.__lib = { artifacts, files, images, asked: [] };
    const answer = (m) => {
      lib.asked.push(JSON.parse(JSON.stringify(m)));
      if (m.type === "ready" || m.type === "list") {
        if (m.type === "ready") { say({ type: "artifactsOffered", on: lib.artifacts !== null }); say({ type: "workImagesOffered", on: true }); }
        say({ type: "library", files: lib.files, total: lib.files.length, next: null, counts: {}, origins: {} });
      } else if (m.type === "artifactList") { if (lib.artifacts === null) say({ type: "artifactsOffered", on: false }); else say({ type: "artifacts", items: lib.artifacts }); }
      else if (m.type === "workImages") say({ type: "workImages", seq: m.seq || 0, offset: 0, images: lib.images, total: lib.images.length, next: null });
      else if (m.type === "image") say({ type: "image", id: m.file.id, data: PNG });
      else if (m.type === "workImage") say({ type: "workImageData", path: m.path, data: PNG });
    };
    const posted = window.__posted, push = posted.push;
    posted.push = function (m) { const n = push.call(this, m); if (m && m.type === "sideLibrary" && m.message) setTimeout(() => answer(m.message), 1); return n; };
    // (What the page asked before this stand-in was here is answered now.)
    for (const m of [...posted]) if (m && m.type === "sideLibrary" && m.message) answer(m.message);
  }, { artifacts, files, images, PNG });
  await x.settle(); await x.page.waitForTimeout(80); await x.settle();
  const lib = () => x.page.evaluate(() => {
    const home = document.getElementById("library-home"); if (!home) return null;
    const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
    const rows = [...home.querySelectorAll(".lib-row")].map((r) => ({ key: r.dataset.key, type: r.dataset.type, title: r.querySelector(".lib-row-name")?.textContent || "", meta: (r.querySelector(".lib-row-meta")?.textContent || "").replace(/\s+/g, " ").trim(),
      maker: r.querySelector(".lib-row-maker")?.textContent || "", makerIs: r.querySelector(".lib-row-maker")?.tagName || "", thumb: r.querySelector(".lib-row-thumb img") ? "img" : r.querySelector(".lib-row-thumb .dgc-sheet") ? "sheet" : r.querySelector(".lib-row-thumb > *") ? "icon" : "", ...box(r) }));
    return { shown: home.checkVisibility(), rows, type: document.getElementById("library-type")?.querySelector(".dgc-folder-v")?.textContent || "", maker: document.getElementById("library-maker")?.querySelector(".dgc-folder-v")?.textContent || "",
      status: document.getElementById("library-status")?.hidden ? "" : document.getElementById("library-status")?.textContent || "", sideways: document.documentElement.scrollWidth > innerWidth };
  });
  const said = (type) => x.page.evaluate((t) => window.__lib.asked.filter((m) => m.type === t), type);
  /** Opens a filter's menu and returns its rows as [{label, checked, head}]. */
  const menu = async (which) => { await x.page.click(`#library-${which}`); await x.page.waitForTimeout(350);
    return x.page.evaluate(() => [...(document.querySelector(".dgc-pop")?.children || [])].filter((n) => n.matches(".dgc-menu-row, .dgc-menu-head")).map((n) => (n.matches(".dgc-menu-head") ? { head: n.textContent.trim() } : { label: n.querySelector(".dgc-menu-label").textContent.trim(), checked: n.getAttribute("aria-checked") === "true" }))); };
  const pick = async (which, label) => { if (!(await x.page.locator(".dgc-pop").count())) await menu(which); await x.page.locator(".dgc-pop .dgc-menu-row", { hasText: label }).first().click(); await x.page.waitForTimeout(250); await x.settle(); };
  return { ...x, lib, said, menu, pick, ar };
}
export { ar };
