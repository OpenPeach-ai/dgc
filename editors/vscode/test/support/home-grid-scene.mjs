// Home as cards (media/shared/homecards.js), in real Chromium on the real side bar (dock-scene.mjs opens it), with a
// small stand-in for the host: it keeps which cards are on Home, their order and their settings the way
// src/homeCards.ts does, and answers the token report and the weather from what the test gives it. Nothing here
// touches a network: the weather is a stand-in's. Shared by home-cards.test.mjs and the pictures. Not a *.test.mjs file.
import { openDock, DOCK_SESSIONS } from "./dock-scene.mjs";
import { homeState, CHATS } from "./home-scene.mjs";

export const DEFAULT = ["needs", "recent", "running", "token", "quick"];
export const EVERY = ["needs", "recent", "running", "token", "quick", "work", "chats", "pips", "folders", "clock", "weather", "note"];
const pad = (v) => String(v).padStart(2, "0");
export const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/** `n` days of use ending today (local days, as DGC's report names them), the same numbers on every run. Today: 900,000 in and 340,000 out (1.24M). */
export function usageDays(n = 60, now = new Date()) {
  const out = [];
  for (let back = n - 1; back >= 0; back--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - back);
    const k = (back * 37) % 11, input = back === 0 ? 900000 : 300000 + k * 110000, output = back === 0 ? 340000 : 60000 + k * 21000;
    out.push({ date: dayKey(d), input_tokens: input, output_tokens: output, cached_input_tokens: Math.round(input * (0.4 + (k % 4) * 0.1)), requests: back === 0 ? 96 : 20 + k * 9 });
  }
  return out;
}
export const USAGE = () => ({ type: "homeUsage", days: usageDays(), models: [{ name: "deepseek-v4.1-flash:cloud", tokens: 19700000 }, { name: "Claude Code (subscription)", tokens: 8300000 }, { name: "qwen3.5-coder (this computer)", tokens: 3800000 }], error: "" });
export const WEATHER = { type: "homeWeather", ok: true, place: "Lisbon, Portugal", at: Date.now(), now: { temp: 24.3, code: 2, day: true }, high: 26.1, low: 17.4,
  hours: [{ time: "15:00", temp: 24.6, code: 1 }, { time: "16:00", temp: 24.1, code: 2 }, { time: "17:00", temp: 23.0, code: 3 }, { time: "18:00", temp: 21.4, code: 61 }, { time: "19:00", temp: 20.2, code: 61 }] };
export const FOLDERS = { choice: "", window: { folder: "/home/me/shop", shown: "~/shop", name: "shop" }, rows: [
  { folder: "/home/me/shop", shown: "~/shop", name: "shop", here: true, exists: true, sessions: 14, pips: 1, workspace_id: null },
  { folder: "/home/me/garden-notes", shown: "~/garden-notes", name: "garden-notes", here: false, exists: true, sessions: 6, pips: 0, workspace_id: null },
  { folder: "/home/me/rust_ire", shown: "~/rust_ire", name: "rust_ire", here: false, exists: true, sessions: 3, pips: 2, workspace_id: null },
  { folder: "/home/me/old-site", shown: "~/old-site", name: "old-site", here: false, exists: false, sessions: 1, pips: 0, workspace_id: null },
  { folder: "/home/me/invoices", shown: "~/invoices", name: "invoices", here: false, exists: true, sessions: 2, pips: 0, workspace_id: null }] };

/** Opens Home with its cards. layout: the cards on Home, in order; settings: { clock, weather, note } as the host keeps
 *  them; usage: the token report (null: none yet); weather: what the stand-in service says (or { ok: false, reason });
 *  folders: the Project Folder rows (null: a DGC that lists none); news: Work replies nobody saw ([{ id, at, preview }]).
 *  Everything else is dock-scene's (width, height, theme, motion, state, sessions, video...). */
export async function openGrid(browser, { layout = DEFAULT, settings = {}, usage = USAGE(), weather = WEATHER, folders = FOLDERS, news = [], sessions = DOCK_SESSIONS, state = homeState("busy"), ...rest } = {}) {
  const x = await openDock(browser, { tab: "home", sessions, state, height: 900, grid: true, ...rest });
  const requests = [];
  x.page.on("request", (r) => requests.push(r.url()));
  await x.page.evaluate(({ layout, settings, usage, weather, DEFAULT }) => {
    const kept = window.__homeCards = { order: [...layout], settings: JSON.parse(JSON.stringify(settings)) };
    window.__homeUsage = usage; window.__homeWeather = weather; window.__weatherAsked = [];
    const tell = (data) => window.dispatchEvent(new MessageEvent("message", { data: JSON.parse(JSON.stringify(data)) }));
    const say = () => tell({ type: "homeCards", ...kept });
    const host = (m) => {
      if (!m || typeof m.type !== "string" || !m.type.startsWith("home")) return;
      if (m.type === "homeCardsReady") say();
      else if (m.type === "homeCardsSet") { kept.order = [...new Set(m.order)]; say(); }
      else if (m.type === "homeCardsReset") { kept.order = [...DEFAULT]; say(); }
      else if (m.type === "homeCardSetting") { kept.settings[m.card] = { ...(kept.settings[m.card] || {}), ...m.settings }; say(); if (m.card === "weather" && m.settings.city !== undefined) { window.__weatherAsked.push(kept.settings.weather.city); tell(window.__homeWeather); } }
      else if (m.type === "homeUsageGet") { if (window.__homeUsage) tell(window.__homeUsage); }
      else if (m.type === "homeWeatherGet") { window.__weatherAsked.push(kept.settings.weather?.city || ""); if (kept.settings.weather?.city) tell(window.__homeWeather); }
    };
    const posted = window.__posted, push = posted.push;
    posted.push = function (m) { const n = push.call(this, m); try { host(m); } catch (error) { window.__homeCardsError = String(error); } return n; };
    say();
    if (usage) tell(usage);
    if (kept.settings.weather?.city) tell(weather);
  }, { layout, settings, usage, weather, DEFAULT });
  if (folders || news.length) await x.send({ type: "sessions_list", items: sessions, error: "", ...(folders ? { folders } : {}), ...(news.length ? { news } : {}) });
  await x.settle();
  /** Until the cards have come to rest (a glide, a flip wave). */
  const rest2 = async (ms = 80) => { await x.page.evaluate((w) => new Promise((d) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(d, w)))), ms); };
  const resize = async (width, height = 900) => { await x.page.setViewportSize({ width, height }); await rest2(700); };
  return { ...x, requests, grid: () => gridNow(x.page), rest: rest2, resize, host: () => x.page.evaluate(() => JSON.parse(JSON.stringify(window.__homeCards))) };
}

/** Home's cards as they are on screen: the grid's form, each card (which, its form, its box, its words), what is opened,
 *  the Cards button, the library and Arrange Home. */
export const gridNow = (page) => page.evaluate(() => {
  const hub = document.getElementById("home-hub"), rect = (n) => { const r = n.getBoundingClientRect(); return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height }; };
  const grid = hub?.querySelector(".hc-grid"), open = hub?.querySelector(".hc-open"), lib = document.querySelector("dialog.hc-library"), button = hub?.querySelector(".hc-cards-btn");
  const words = (n) => (n.innerText || "").replace(/\s+/g, " ").trim();
  const card = (c) => ({ id: c.dataset.card, form: c.dataset.form, text: words(c), label: c.getAttribute("aria-label") || "", lifted: c.classList.contains("hc-lifted"), x: !!c.querySelector(".hc-x")?.checkVisibility(), ...rect(c) });
  return { there: !!grid, form: grid?.dataset.form || "", shown: !!grid?.checkVisibility(), arranging: !!grid?.classList.contains("hc-arranging"),
    cards: grid ? [...grid.querySelectorAll(":scope > .hc-card")].map(card) : [],
    open: open && !open.hidden ? { ...card(open.querySelector(".hc-card")), back: words(hub.querySelector(".hc-back")) } : null,
    button: button ? { text: words(button), mosaic: button.querySelector(".mosaic")?.className || "", tiles: button.querySelectorAll(".mosaic > i").length, play: button.querySelector(".mosaic i:nth-child(4)") ? getComputedStyle(button.querySelector(".mosaic i:nth-child(4)")).animationPlayState : "",
      motion: button.querySelector(".mosaic i:nth-child(4)") ? getComputedStyle(button.querySelector(".mosaic i:nth-child(4)")).animationName : "", radius: getComputedStyle(button).borderTopLeftRadius, ...rect(button) } : null,
    library: lib?.open ? { ...rect(lib), items: [...lib.querySelectorAll(".hc-lib-item")].map((i) => ({ id: i.dataset.card, name: words(i.querySelector(".hc-lib-name")), line: words(i.querySelector(".hc-lib-line")), on: !!i.querySelector(".hc-onhome"), add: !!i.querySelector(".hc-add"), remove: !!i.querySelector(".hc-remove"),
      mosaics: i.querySelectorAll(".mosaic").length, preview: words(i.querySelector(".hc-lib-pv")), previewDrawn: i.querySelector(".hc-lib-pv").childElementCount > 0 })),
      title: [...lib.querySelectorAll(".hc-lib-head .mosaic")].map((m) => m.className), foot: [...lib.querySelectorAll(".hc-lib-foot button")].map(words) } : null,
    head: hub ? words(hub.querySelector(".hc-head")) : "", width: innerWidth, overflowX: document.documentElement.scrollWidth > innerWidth,
    focus: document.activeElement?.closest?.(".hc-card")?.dataset.card || document.activeElement?.className || "" };
});
