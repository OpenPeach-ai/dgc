// The Library (0.52, Library v2, 15 Nov): ONE module (media/library.js) draws it in the side bar's Library tab and in
// its editor tab. Here both, in real Chromium: openLibraryTab is the real side bar (dock-scene.mjs opens it) on its
// Library tab, openLibraryPage the page src/chatdgc.ts serves in an editor tab (chat-scene.mjs opens it). One stand-in
// for the host answers what the module asks, the way src/chatdgc.ts does: the artifacts with who made each, ChatDGC's
// widgets and files, every image and video DGC made in Work, ChatDGC and the Pips (with made_by, and kept ones).
// lib() reads the Library as drawn, the same in both. Shared by the Library's tests, the narrowest-words walk and the
// pictures. Not a *.test.mjs file.
import { openDock, pipId } from "./dock-scene.mjs";
import { openLibrary } from "./chat-scene.mjs";
import { SESSIONS, CHATS } from "./home-scene.mjs";

const ar = (n) => "ar_" + String(n).repeat(16).slice(0, 16);
// (How long ago each thing was made is kept in minutes and written as a time when a scene opens, so "40m" reads 40m
// however long the test file has been running.)
const AGES = new Map(), ago = (minutes) => { const said = `ago:${minutes}`; AGES.set(said, minutes); return said; };
const dated = (list) => (Array.isArray(list) ? list.map((item) => Object.fromEntries(Object.entries(item).map(([k, v]) => [k, typeof v === "string" && /^ago:\d+$/.test(v) ? new Date(Date.now() - Number(v.slice(4)) * 60000).toISOString() : v]))) : list);
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
// Small sample pictures (32 px PNGs, drawn for the scene): by the words in an image's path, else the last.
const PICTURES = { price: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAOklEQVR42mP4/OUHTRHDqAWjFpCFamL+w9GoBaRZgCwxasGoBXjVj1owasGoBWRYQIn4qAWjFgwBCwCv+U93BeXqBQAAAABJRU5ErkJggg==",
  tile: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAErUlEQVR42h3CBU4rAQBAwT3duvueAggS+AQJEiRIkHAJILi2FGuxUqE4FHe4xE/eZISpgkiJ8lRBoVr506jTqPyZtKYKNh26UwWPfuUvYMio8hczESZPRUqUJ08VquVfjTqN8q9Ja/LUpkN38tSjX/4NGDIq/8ZMhIm8SInyRF6hWvrRqNMo/Zi0JvI2HboTeY9+6SdgyKj0EzMRxk9ESpTHTxSqxW+NOo3it0lr/MSmQ3f8xKNf/A4YMip+x0yEsWOREuWxY4Vq4UujTqPwZdIaO7bp0B079ugXvgKGjApfMRNh9EikRHn0SKGa/9So08h/mrRGj2w6dEePPPr5z4Aho/xnzEQYORQpUR45VKiefGjUaZx8mLRGDm06dEcOPfonHwFDRicfMRNh+ECkRHn4QKF6/K5Rp3H8btIaPrDp0B0+8OgfvwcMGR2/x0yEozeREuWjN4XqUE6jTmMoZ9I6erPp0D168+gP5QKGjIZyMRPh4FWkRPngVaE6mNWo0xjMmrQOXm06dA9ePfqD2YAho8FszETIvYiUKOdeFKoD+xp1GgP7Jq3ci02Hbu7Foz+wHzBkNLAfMxGyzyIlytlnhWr/nkadRv+eSSv7bNOhm3326PfvBQwZ9e/FTIT9J5ES5f0nhWrfrkadRt+uSWv/yaZDd//Jo9+3GzBk1LcbMxF2H0VKlHcfFaq9Oxp1Gr07Jq3dR5sO3d1Hj37vTsCQUe9OzETYeRApUd55UKj2bGvUafRsm7R2Hmw6dHcePPo92wFDRj3bMRNhuypSorxdVah2ZzTqNLozJq3tqk2H7nbVo9+dCRgy6s7ETISujEiJcldGoZqpatRpZKomra6MTYduV8ajn6kGDBllqjEToXNLpES5c0uhmr7XqNNI35u0OrdsOnQ7tzz66fuAIaP0fcxE6EiLlCh3pBWqqTuNOo3UnUmrI23ToduR9uin7gKGjFJ3MROhPSVSotyeUqhu3mrUaWzemrTaUzYduu0pj/7mbcCQ0eZtzERo2xQpUW7bVKhu3GjUaWzcmLTaNm06dNs2PfobNwFDRhs3MROhdUOkRLl1Q6G6dq1Rp7F2bdJq3bDp0G3d8OivXQcMGa1dx0yEf+siJcr/1hWqq1cadRqrVyatf+s2Hbr/1j36q1cBQ0arVzEToWVNpES5ZU2hunKpUaexcmnSalmz6dBtWfPor1wGDBmtXMZMhOULkRLl5QuFavOqRp1G86pJa/nCpkN3+cKj37waMGTUvBozERbPRUqUF88Vqk0rGnUaTSsmrcVzmw7dxXOPftNKwJBR00rMRFioiJQoL1QUqo3LGnUajcsmrYWKTYfuQsWj37gcMGTUuBwzEebPREqU588Uqg1LGnUaDUsmrfkzmw7d+TOPfsNSwJBRw1LMRJgri5Qoz5UVqvWLGnUa9YsmrbmyTYfuXNmjX78YMGRUvxgzEWZLIiXKsyWFat2CRp1G3YJJa7Zk06E7W/Lo1y0EDBnVLcRMhJmiSInyTFGhWjuvUadRO2/SminadOjOFD36tfMBQ0a18zETYbogUqI8XVCo1sxp1GnUzJm0pgs2HbrTBY9+zVzAkFHNXMzkPzp38lu2GRSBAAAAAElFTkSuQmCC",
  beach: "data:image/png;base64,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",
  logo: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAIAAAD8GO2jAAAAfUlEQVR42u2WSQ6AIBAE+xkcfJpP8e/KybgkSrqa2yRzAkLVsAyotWVqqAAF4IBt3c949F27Rga8Z++N+h0BDcSn+FbUSJrEQJF1QABooNRmIgAxUPBEIoBtoOy1QgDPQPHagACGgWYUuBvAK8IIkE1C9kuCAMEk6ldRAB4HibQFPkb/D5sAAAAASUVORK5CYII=" };
const PNG = PICTURES.logo;
export const LIB_FILES = [
  { source: "chat", chat_id: CHATS[0].id, id: "att_" + "3".repeat(32), name: "Beach map.png", kind: "image", type: "image", mime: "image/png", size: 48213, created_at: ago(90), chat_title: "A week in Goa in March", made: true },
  { source: "chat", chat_id: CHAT, id: "att_" + "4".repeat(32), name: "Billing review.pdf", kind: "document", type: "pdf", mime: "application/pdf", size: 918213, created_at: ago(60 * 30), chat_title: "Rent or buy: the numbers", made: false },
  { source: "project", project_id: "project_" + "a".repeat(32), project_name: "Goa trip", id: "att_" + "5".repeat(32), name: "ferry-times.csv", kind: "document", type: "spreadsheet", size: 2210, created_at: ago(60 * 24 * 5) },
];
/** Every image DGC made or kept, as images_library lists them with no surface: one from a Work session, one from a
 *  chat, one a Pip kept on purpose (kept, its title and why), one from the terminal (no name to go back to). */
export const LIB_IMAGES = [
  { path: "/home/me/.dgc/images/kept/tile-prices-20261115.png", rel: "", prompt: "Tile prices, 2024 to 2026", title: "Tile prices, 2024 to 2026", why: "The chart for the supplier call", kept: true, surface: "pip",
    made_by: { kind: "pip", id: TILE, name: "Tile checker" }, generator_name: "", project: "", created_at: ago(12), width: 1200, height: 800, bytes: 88200 },
  { path: "/home/me/.dgc/images/chat/beach-dusk.png", rel: "", prompt: "A beach at dusk, in watercolour", surface: "chat", made_by: { kind: "chat", id: CHAT, name: "Rent or buy: the numbers" }, generator_name: "Images", project: "",
    created_at: ago(45), width: 1024, height: 1024, bytes: 512000 },
  { path: "/home/me/shop/assets/hero-tiles.png", rel: "assets/hero-tiles.png", prompt: "A wall of lime green tiles in morning light", surface: "work", made_by: { kind: "session", id: SESSION, name: "Fix totals" }, generator_name: "Images", model: "",
    project: "/home/me/shop", created_at: ago(200), width: 1024, height: 768, bytes: 381200 },
  { path: "/home/me/.dgc/images/cli/logo-slashes.png", rel: "", prompt: "A logo of three slashes", surface: "cli", made_by: { kind: "cli", id: "", name: "" }, generator_name: "Images", project: "", created_at: ago(60 * 24 * 4), width: 512, height: 512, bytes: 40100 },
];
export const LIB_VIDEOS = [
  { path: "/home/me/.dgc/videos/tiles-laid.mp4", prompt: "Tiles being laid, a time-lapse", surface: "pip", made_by: { kind: "pip", id: TILE, name: "Tile checker" }, generator_name: "Veo", seconds: 6, width: 1280, height: 720, bytes: 2400000, created_at: ago(70), job: "vid_1" },
  { path: "/home/me/shop/assets/hero-loop.mp4", prompt: "The hero wall, a slow pan", surface: "work", made_by: { kind: "session", id: SESSION, name: "Fix totals" }, generator_name: "Veo", seconds: 8, width: 1920, height: 1080, bytes: 5400000, created_at: ago(60 * 20), job: "vid_2" },
];
/** ChatDGC's own widgets (chatdgc_widgets): each is in a chat. */
export const LIB_WIDGETS = [
  { id: "wg_" + "4".repeat(16), chat_id: CHATS[0].id, chat_title: "A week in Goa in March", title: "Trip budget calculator", created_at: ago(300) },
];

/** The stand-in for the Library's host (src/chatdgc.ts fromLibrary), run in the page: `say(message)` is how the host
 *  answers. window.__lib keeps what it lists and what it was asked. */
const HOST = `(${function (data, say, PNG, PICTURES) {
  const picture = (path) => PICTURES[Object.keys(PICTURES).find((word) => String(path).toLowerCase().includes(word))] || PNG;
  const lib = window.__lib = { ...data, asked: [] };
  const has = (text, q) => !q || String(text || "").toLowerCase().includes(String(q).toLowerCase());
  return (m) => {
    lib.asked.push(JSON.parse(JSON.stringify(m)));
    if (m.type === "ready" || m.type === "list") {
      if (m.type === "ready") { say({ type: "dock", pins: lib.pins || [], colours: {} }); say({ type: "widgetsOffered", on: lib.widgets !== null }); say({ type: "workImagesOffered", on: lib.images !== null });
        say({ type: "artifactsOffered", on: lib.artifacts !== null }); say({ type: "videosOffered", on: lib.videos !== null }); if (lib.view) say({ type: "view", view: lib.view }); }
      const files = lib.files.filter((f) => has(f.name, m.query) && (!m.kind || f.type === m.kind) && (!m.origin || (m.origin === "made") === (f.made === true)));
      const counts = {}; for (const f of lib.files) counts[f.type] = (counts[f.type] || 0) + 1;
      say({ type: "library", files, total: files.length, next: null, counts, origins: { made: lib.files.filter((f) => f.made).length, uploaded: lib.files.filter((f) => !f.made).length } });
    } else if (m.type === "artifactList") { if (lib.artifacts === null) say({ type: "artifactsOffered", on: false }); else say({ type: "artifacts", items: lib.artifacts }); }
    else if (m.type === "widgets") { say({ type: "widgetsOffered", on: lib.widgets !== null }); if (lib.widgets !== null) say({ type: "widgets", widgets: lib.widgets.filter((w) => has(w.title, m.query)), next: null }); }
    else if (m.type === "workImages") { if (lib.images === null) { say({ type: "workImagesOffered", on: false }); return; }
      const found = lib.images.filter((i) => (!m.surface || i.surface === m.surface) && (has(i.prompt, m.query) || has(i.path.split("/").pop(), m.query)));
      const from = m.offset || 0, page = lib.pageSize || 60, next = from + page < found.length ? from + page : null;
      say({ type: "workImages", seq: m.seq || 0, offset: from, images: found.slice(from, from + page), total: found.length, next }); }
    else if (m.type === "videoList") { if (lib.videos === null) { say({ type: "videosOffered", on: false }); return; }
      const found = lib.videos.filter((v) => (!m.surface || v.surface === m.surface) && has(v.prompt, m.query));
      say({ type: "videos", seq: m.seq || 0, offset: m.offset || 0, videos: found, total: found.length, next: null }); }
    else if (m.type === "image") say({ type: "image", id: m.file.id, data: picture(m.file.name) });
    else if (m.type === "workImage") say({ type: "workImageData", path: m.path, data: picture(m.path) });
    // Copy (an item's menu): the host reads the picture and hands it back for the clipboard, as src/chatdgc.ts libraryAct does.
    else if (m.type === "itemAct" && m.act === "copy" && m.item && m.item.kind === "image") say({ type: "itemCopy", key: "image:" + m.item.path, data: picture(m.item.path) });
    else if (m.type === "itemAct" && m.act === "copy" && m.item && m.item.kind === "file") say({ type: "itemCopy", key: "file:" + m.item.id, data: picture((lib.files.find((f) => f.id === m.item.id) || {}).name) });
  };
}.toString()})`;

/** The Library as drawn (the same reading in the side bar and in the editor tab). */
const drawn = (page) => page.evaluate(() => {
  const root = document.querySelector(".dgc-lib"); if (!root) return null;
  const box = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, w: r.width, h: r.height }; };
  const seen = (n) => !!n && n.checkVisibility({ visibilityProperty: true, opacityProperty: true });
  const one = (id) => { const n = document.getElementById(id); return n && seen(n) ? box(n) : null; };
  const rows = [...root.querySelectorAll("#library-list > .lib-row")].map((r) => ({ key: r.dataset.key, type: r.dataset.type, title: r.querySelector(".lib-row-name")?.textContent || "",
    meta: [...(r.querySelector(".lib-row-meta")?.children || [])].filter((n) => seen(n)).map((n) => n.textContent).join("").replace(/\s+/g, " ").trim(),
    by: (r.querySelector(".lib-row-by")?.textContent || "").trim(), when: (r.querySelector(".lib-row-when")?.textContent || "").replace(/[\s·]+/g, ""),
    maker: r.querySelector(".lib-row-maker")?.textContent || "", makerIs: r.querySelector(".lib-row-maker")?.tagName || "", tip: r.title || "",
    thumb: r.querySelector(".lib-row-thumb img") ? "img" : r.querySelector(".lib-row-thumb .dgc-sheet") ? "sheet" : r.querySelector(".lib-row-thumb [data-mark]") ? "mark" : r.querySelector(".lib-row-thumb > *") ? "icon" : "",
    acts: [...r.querySelectorAll(".lib-row-actions [data-act]")].filter(seen).map((b) => b.dataset.act), more: seen(r.querySelector(".lib-row-more")), ...box(r) }));
  const tabs = [...root.querySelectorAll('#library-tabs [role="tab"]')].filter((t) => !t.hidden).map((t) => { const word = t.querySelector(".lib-tab-word"), icon = t.querySelector(".lib-tab-icon"), w = word.getBoundingClientRect();
    return { id: t.dataset.tab, name: word.textContent, selected: t.getAttribute("aria-selected") === "true", tabindex: t.tabIndex, word: w.width > 2 && w.height > 2, icon: seen(icon) && icon.getBoundingClientRect().width > 2,
      cut: word.scrollWidth > word.clientWidth + 1 && w.width > 2 || w.right > t.getBoundingClientRect().right + 0.5, label: t.getAttribute("aria-label") || "", tip: t.title || "", radius: parseFloat(getComputedStyle(t).borderTopLeftRadius), ...box(t) }; });
  const filters = [...root.querySelectorAll("#library-filters .lib-filter")].filter(seen).map((b) => ({ id: b.id.replace("library-filter-", ""), key: b.querySelector(".dgc-folder-k")?.textContent || "", keySeen: seen(b.querySelector(".dgc-folder-k")) && b.querySelector(".dgc-folder-k").getBoundingClientRect().width > 2,
    value: b.querySelector(".dgc-folder-v")?.textContent || "", radius: parseFloat(getComputedStyle(b).borderTopLeftRadius), ...box(b) }));
  const head = root.querySelector(".dgc-pagehead"), search = document.getElementById("library-search"), status = document.getElementById("library-status");
  return { place: root.dataset.place || "", shown: seen(root), head: head ? box(head) : null, title: head?.querySelector(".dgc-pagehead-title")?.textContent || "", more: one("library-more"), search: search ? { ...box(search), placeholder: search.placeholder, value: search.value } : null,
    tabsBar: one("library-tabs"), tabs, tab: tabs.find((t) => t.selected)?.id || "", filtersBar: one("library-filters"), filters, rows, list: one("library-list"),
    status: status && !status.hidden ? status.textContent : "", load: seen(document.getElementById("library-load")), sideways: document.documentElement.scrollWidth > innerWidth + 1, width: innerWidth };
});

function helpers(x, page) {
  const lib = () => drawn(page);
  const said = (type) => page.evaluate((t) => window.__lib.asked.filter((m) => !t || m.type === t), type);
  const rest = async (ms = 80) => { await page.waitForTimeout(ms); await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 40))))); };
  /** Chooses one of the Library's own tabs (artifacts, widgets, images, videos, files). */
  const tab = async (id) => { await page.click(`#library-tab-${id}`); await rest(120); };
  /** Opens a filter's menu (kind, maker, origin) and returns its rows as [{label, checked} | {head}]. */
  const menu = async (which) => { await page.click(`#library-filter-${which}`); await page.waitForTimeout(350);
    return page.evaluate(() => [...(document.querySelector(".dgc-pop")?.children || [])].filter((n) => n.matches(".dgc-menu-row, .dgc-menu-head")).map((n) => (n.matches(".dgc-menu-head") ? { head: n.textContent.trim() } : { label: n.querySelector(".dgc-menu-label").textContent.trim(), checked: n.getAttribute("aria-checked") === "true" }))); };
  const pick = async (which, label) => { if (!(await page.locator(".dgc-pop").count())) await menu(which); await page.locator(".dgc-pop .dgc-menu-row", { hasText: label }).first().click(); await rest(250); };
  /** The rows of whichever menu is open, by their words. */
  const menuRows = () => page.evaluate(() => [...document.querySelectorAll(".dgc-pop .dgc-menu-row")].map((r) => r.querySelector(".dgc-menu-label")?.textContent.trim() || r.textContent.trim()));
  const search = async (words) => { await page.fill("#library-search", words); await rest(450); };
  return { lib, said, rest, libTab: tab, menu, pick, menuRows, search, ar };
}

/** Opens the side bar on its Library tab. artifacts/widgets/files/images/videos: what the host lists (null: this DGC
 *  offers none of that kind); pins: what is on the dock; everything else is dock-scene's. Returns its helpers plus
 *  lib() (the Library as drawn), said(type) (what the module asked the host through "sideLibrary"), libTab(id),
 *  menu(which), pick(which, label), search(words). */
export async function openLibraryTab(browser, { artifacts = LIB_ARTIFACTS, widgets = LIB_WIDGETS, files = LIB_FILES, images = LIB_IMAGES, videos = LIB_VIDEOS, pageSize = 60, tab = "library", ...rest } = {}) {
  const x = await openDock(browser, { tab, height: 760, ...rest });
  await x.page.evaluate(({ data, HOST, PNG, PICTURES }) => {
    const say = (message) => window.dispatchEvent(new MessageEvent("message", { data: { type: "sideLibrary", message: JSON.parse(JSON.stringify(message)) } }));
    const answer = (0, eval)(HOST)(data, say, PNG, PICTURES);
    const posted = window.__posted, push = posted.push;
    posted.push = function (m) { const n = push.call(this, m); if (m && m.type === "sideLibrary" && m.message) setTimeout(() => answer(m.message), 1); return n; };
    // (What the page asked before this stand-in was here is answered now.)
    for (const m of [...posted]) if (m && m.type === "sideLibrary" && m.message) answer(m.message);
  }, { data: { artifacts: dated(artifacts), widgets: dated(widgets), files: dated(files), images: dated(images), videos: dated(videos), pageSize }, HOST, PNG, PICTURES });
  await x.settle(); await x.page.waitForTimeout(80); await x.settle();
  return { ...x, ...helpers(x, x.page), place: "side" };
}

/** Opens the Library in its editor tab (the page src/chatdgc.ts serves), on the same stand-in host. `view`: the tab
 *  the host opens it on ("" for the page's own). */
export async function openLibraryPage(browser, { artifacts = LIB_ARTIFACTS, widgets = LIB_WIDGETS, files = LIB_FILES, images = LIB_IMAGES, videos = LIB_VIDEOS, pageSize = 60, pins = [], view = "", width = 1100, height = 760, theme = "dark-modern", state, touch = false, forced = false, scale = 1, secure = false } = {}) {
  const x = await openLibrary(browser, { width, height, theme, state, touch, forced, scale, secure });
  await x.page.evaluate(({ data, HOST, PNG, PICTURES }) => {
    const say = (message) => window.dispatchEvent(new MessageEvent("message", { data: JSON.parse(JSON.stringify(message)) }));
    const answer = (0, eval)(HOST)(data, say, PNG, PICTURES);
    const posted = window.__posted, push = posted.push;
    posted.push = function (m) { const n = push.call(this, m); if (m && typeof m.type === "string") setTimeout(() => answer(m), 1); return n; };
    for (const m of [...posted]) if (m && typeof m.type === "string") answer(m);
  }, { data: { artifacts: dated(artifacts), widgets: dated(widgets), files: dated(files), images: dated(images), videos: dated(videos), pageSize, pins, view }, HOST, PNG, PICTURES });
  const settle = () => x.page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(done, 60)))));
  await settle(); await x.page.waitForTimeout(80); await settle();
  const close = () => x.page.close();
  return { ...x, settle, close, ...helpers(x, x.page), place: "tab" };
}
export { ar, dated };
