// Pictures of the code card (0.52, Pips API 98) in every state, from the real pages in real Chromium: its card in the
// Pip's chat (170, 300, 440 and 700 px) and its notification in the computer view (1100 px, and 440), dark and light,
// with a mouse and with a finger. States: live, sending, sent, signed in, error, lost, expired, and answered elsewhere.
// Each picture is the whole page; `sheets/` has them side by side, cut to the card, for looking through.
//   node test/support/code-card-pictures.mjs <out-dir> [chat|computer|library|tabs]
// Not a *.test.mjs file.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "@playwright/test";
import { openChat } from "./pip-chat-scene.mjs";
import { openComputer, PIP } from "./pip-computer-scene.mjs";

const out = process.argv[2], only = process.argv[3] || "";
if (!out) { console.error("usage: node test/support/code-card-pictures.mjs <out-dir> [chat|computer|library|tabs]"); process.exit(2); }
mkdirSync(join(out, "sheets"), { recursive: true });
const HOLD = "compact_" + "c".repeat(32), SHOWN = "login.northwind-bank.example";
const FIELD = `input[data-code-field="${HOLD}"]`, CARD = `[data-code-card="${HOLD}"]`;
const STATES = ["live", "sending", "sent", "signed-in", "error", "lost", "expired", "elsewhere"];
const browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] });
const clips = {};   // picture name -> the card's box in it, for the sheets
const note = (name, box, view) => { const pad = 14, y = Math.max(0, box.y - pad), x = Math.max(0, box.x - pad);
  clips[name] = { x, y, width: Math.min(view.width - x, box.width + 2 * pad), height: Math.min(view.height - y, box.height + 2 * pad) }; };

async function chat(state, theme, width, touch) {
  const code = { sending: { after: 60000 }, "signed-in": { mode: "signed" }, error: { mode: "busy" }, lost: { mode: "lost" }, expired: { expiresIn: 2600 } }[state] || {};
  const x = await openChat(browser, { where: width >= 700 ? "tab" : "side", width, height: 560, theme, touch, api: 98, code });
  const name = `chat-${state}-${width}-${theme}-${touch ? "touch" : "mouse"}`;
  try {
    const press = (sel) => (touch ? x.p.tap(sel) : x.p.click(sel));
    if (state === "live") { if (!touch) { await press(FIELD); await x.p.keyboard.type("482913"); } }
    else if (state === "expired") { await x.p.waitForSelector(`${CARD}[data-code-state="expired"]`, { timeout: 12000 }); }
    else if (state === "elsewhere") { await x.p.evaluate(() => Object.assign(window.__code.hold, { status: "rejected", resolved_at: new Date().toISOString(), resolved_by: "local-console" }));
      await x.p.waitForSelector(`${CARD}[data-code-state="elsewhere"]`, { timeout: 20000 }); }
    else { await press(FIELD); await x.p.keyboard.type("482913"); await x.p.keyboard.press("Enter");
      const want = { sending: "sending", sent: "sent", "signed-in": "sent", lost: "lost" }[state];
      if (want) await x.p.waitForSelector(`${CARD}[data-code-state="${want}"]`); else await x.p.waitForSelector(`${CARD} .dgc-card-error`); }
    if (!touch && ["lost", "expired", "elsewhere"].includes(state)) await x.p.hover(`${CARD} button`);
    await x.p.waitForTimeout(260);
    const box = await x.p.locator(CARD).boundingBox();
    await x.p.screenshot({ path: join(out, name + ".png") });
    // (The sheet shows the card and the box under it.)
    note(name, { x: 0, y: box.y, width, height: 560 - box.y - 14 }, { width, height: 560 });
    if (x.errors.length) console.error(name, x.errors);
  } finally { await x.close(); }
}

const action = (more = {}) => ({ id: HOLD, pip_id: PIP.id, workspace_id: "ws", run_id: "run_" + "b".repeat(32),
  summary: { method: "CODE", host: SHOWN, path: "/verify", page: `https://${SHOWN}/verify`, fields: [], more_fields: 0, body_bytes: 0, kind: "code", site: "northwind-bank.example", shown: SHOWN, login: "login_" + "1".repeat(32), filled: ["username", "password"] },
  digest: "d".repeat(64), frame: null, status: "pending", created_at: new Date(Date.now() - 20000).toISOString(), expires_at: new Date(Date.now() + 9 * 60000).toISOString(), resolved_at: null, resolved_by: null, continuation_run_id: null, ...more });
async function computer(state, theme, width, touch) {
  const NOTE = `.pc-card[data-card="${HOLD}"]`, BOX = `${NOTE} input[data-code-field]`;
  const opts = { sending: { codeAfter: 60000 }, "signed-in": { code: "signed" }, error: { code: "error" }, lost: { code: "lost" } }[state] || {};
  const x = await openComputer(browser, { width, height: 640, theme, touch, api: 98, actions: [action(state === "expired" ? { expires_at: new Date(Date.now() + 4000).toISOString() } : {})], ...opts });
  const name = `computer-${state}-${width}-${theme}-${touch ? "touch" : "mouse"}`;
  try {
    const press = (sel) => (touch ? x.p.tap(sel) : x.p.click(sel));
    await x.p.waitForSelector(BOX);
    if (state === "live") { if (!touch) { await press(BOX); await x.p.keyboard.type("482913"); } }
    else if (state === "expired") await x.p.waitForSelector(`${NOTE} .pc-card-note`, { timeout: 20000 });
    else if (state === "elsewhere") { await x.p.evaluate(() => Object.assign(window.__scene.actions[0], { status: "rejected", resolved_at: new Date().toISOString(), resolved_by: "local-console" }));
      await x.p.waitForSelector(`${NOTE} .pc-card-note`, { timeout: 20000 }); }
    else { await press(BOX); await x.p.keyboard.type("482913"); await x.p.keyboard.press("Enter");
      if (state === "sending") await x.p.waitForFunction((sel) => document.querySelector(sel)?.querySelector("button[type=submit]")?.textContent === "Sending…", NOTE);
      else if (state === "error") await x.p.waitForSelector(`${NOTE} .pc-card-error`);
      else if (state === "lost") await x.p.waitForSelector(`${NOTE} .pc-card-note`);
      else await x.p.waitForSelector(`${NOTE} .pc-card-done`); }
    await x.p.waitForTimeout(220);
    const box = await x.p.locator("#pc-drawer").boundingBox();
    await x.p.screenshot({ path: join(out, name + ".png") });
    note(name, box, { width, height: 640 });
    if (x.errors.length) console.error(name, x.errors);
  } finally { await x.close(); }
}

// A sheet: rows are the states, columns the widths (or the pointer), each picture cut to its card.
async function sheet(file, title, rows, cols, nameOf) {
  const cell = (name) => { const c = clips[name]; if (!c) return `<td class="none">${name}</td>`;
    const data = readFileSync(join(out, name + ".png")).toString("base64");
    return `<td><div class="clip" style="width:${c.width}px;height:${c.height}px"><img src="data:image/png;base64,${data}" style="margin:-${c.y}px 0 0 -${c.x}px"></div></td>`; };
  const html = `<!DOCTYPE html><meta charset="utf-8"><style>body{margin:0;padding:14px;background:#777;font:12px system-ui;color:#fff}table{border-collapse:separate;border-spacing:10px 8px}th{text-align:left;font-weight:600;vertical-align:top;white-space:nowrap}
td{vertical-align:top}.clip{overflow:hidden;outline:1px solid #555}.clip img{display:block}h1{font-size:14px;margin:0 0 6px}</style><h1>${title}</h1><table><tr><th></th>${cols.map((c) => `<th>${c}</th>`).join("")}</tr>`
    + rows.map((r) => `<tr><th>${r}</th>${cols.map((c) => cell(nameOf(r, c))).join("")}</tr>`).join("") + "</table>";
  const p = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  await p.setContent(html); await p.waitForTimeout(150);
  const size = await p.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight }));
  await p.setViewportSize({ width: Math.min(size.width, 3600), height: Math.min(size.height, 6000) });
  await p.screenshot({ path: join(out, "sheets", file), fullPage: true }); await p.close();
}

const THEMES = ["dark", "light"], WIDTHS = [170, 300, 440, 700];
try {
  if (!only || only === "chat") for (const theme of THEMES) for (const touch of [false, true]) {
    for (const state of STATES) for (const width of WIDTHS) await chat(state, theme, width, touch);
    const how = touch ? "touch" : "mouse";
    await sheet(`chat-${theme}-${how}-a.png`, `The code card in a Pip's chat, ${theme}, ${how}: live, sending, sent, signed in`, STATES.slice(0, 4), WIDTHS, (s, w) => `chat-${s}-${w}-${theme}-${how}`);
    await sheet(`chat-${theme}-${how}-b.png`, `The code card in a Pip's chat, ${theme}, ${how}: error, lost, expired, answered elsewhere`, STATES.slice(4), WIDTHS, (s, w) => `chat-${s}-${w}-${theme}-${how}`);
    console.log("chat", theme, how);
  }
  if (!only || only === "computer") for (const theme of THEMES) {
    for (const state of STATES) for (const [width, touch] of [[1100, false], [1100, true], [440, false], [440, true]]) await computer(state, theme, width, touch);
    await sheet(`computer-${theme}.png`, `The code card's notification in the computer view, ${theme}`, STATES, ["1100 mouse", "1100 touch", "440 mouse", "440 touch"], (s, c) => `computer-${s}-${c.split(" ")[0]}-${theme}-${c.split(" ")[1]}`);
    console.log("computer", theme);
  }
  // The Library fix that came with it (finding 49): a pointed-at row's title ends in "…" before its ⋯, at every width.
  if (!only || only === "library") {
    const { openLibraryTab } = await import("./library-scene.mjs");
    for (const theme of ["dark-modern", "light-modern"]) {
      const names = [];
      for (const [width, touch] of [[170, false], [220, false], [300, false], [440, false], [170, true], [300, true]]) {
        const x = await openLibraryTab(browser, { width, theme, touch }), name = `library-images-${width}-${theme.split("-")[0]}-${touch ? "touch" : "mouse"}`;
        try {
          await x.libTab("images"); await x.settle();
          const at = await x.page.evaluate(() => { const b = document.querySelectorAll("#library-home .lib-row")[1].getBoundingClientRect(); return { x: b.left + 24, y: b.top + b.height / 2 }; });
          if (!touch) await x.page.mouse.move(at.x, at.y);
          await x.settle(); await x.page.waitForTimeout(150);
          await x.page.screenshot({ path: join(out, name + ".png") });
          note(name, { x: 0, y: 0, width, height: 470 }, { width, height: 760 }); names.push(name);
        } finally { await x.close(); }
      }
            await sheet(`library-images-${theme.split("-")[0]}.png`, `Library, Images: the second row pointed at (mouse), or as a finger sees it (touch), ${theme}`, ["images"], names, (_r, c) => c);
      console.log("library", theme);
    }
  }
  // The header's tabs (decided 15 Nov): Library is a word, and a plain line icon when the tabs are icons; only
  // Pips has a picture. Words from 280 px.
  if (!only || only === "tabs") {
    const { openDock } = await import("./dock-scene.mjs");
    for (const theme of ["dark-modern", "light-modern"]) {
      const names = [];
      for (const [width, tab] of [[170, "home"], [220, "library"], [279, "home"], [280, "home"], [300, "library"], [440, "home"], [700, "home"]]) {
        const x = await openDock(browser, { tab, width, height: 420, theme }), name = `tabs-${width}-${theme.split("-")[0]}`;
        try { await x.page.mouse.move(1, 300); await x.settle(); await x.page.waitForTimeout(120); await x.page.screenshot({ path: join(out, name + ".png") });
          note(name, { x: 0, y: 0, width, height: 110 }, { width, height: 420 }); names.push(name); } finally { await x.close(); }
      }
      await sheet(`tabs-${theme.split("-")[0]}.png`, `The side bar's tabs, ${theme}: 170, 220 (on Library), 279, 280, 300 (on Library), 440, 700`, ["tabs"], names, (_r, c) => c);
      console.log("tabs", theme);
    }
  }
  console.log(`${readdirSync(out).filter((f) => f.endsWith(".png")).length} pictures in ${out}`);
} finally { await browser.close(); }
