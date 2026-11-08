import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { readStylesheet, TOKENS_CSS } from "./support/stylesheet.mjs";
import { THEMES } from "./support/options-scene.mjs";
import { openWorkTab } from "./support/work-tab-scene.mjs";
import { openChat, conversation, OFFER } from "./support/chat-scene.mjs";

// One menu for "+" and every picker (0.52, UI step 2; his U2: three groups). Work, ChatDGC and the Pips each drew their
// own menus: a heavy black shadow, 24 px rows, monospace hints, uppercase kickers, and keys that worked in some and not
// others (Work's "+" menu answered no arrow keys at all; ChatDGC's model menu neither). Now media/shared/menu.css is how
// every one of them looks and media/shared/menu.js answers the same keys in all of them.

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");

// Every top-level await before the first test() (see node-test top-level-await race).
let chromium;
try { ({ chromium } = await import("@playwright/test")); } catch { chromium = null; }
let browser;
before(async () => {
  if (!chromium) return;
  try { browser = await chromium.launch({ args: ["--headless=new", "--no-sandbox", "--force-color-profile=srgb"] }); } catch { browser = null; }
});
after(async () => { await browser?.close(); });
const skipOrFail = (t) => {
  const why = !chromium ? "playwright is not installed (npm ci at the repository root)" : !browser ? "Chromium could not start" : "";
  if (!why) return false;
  if (process.env.DGC_REQUIRE_CHROMIUM === "1") assert.fail(`DGC_REQUIRE_CHROMIUM=1: ${why}`);
  t.skip(why);
  return true;
};

test("every menu in Work, ChatDGC and a Pip's chat is the shared menu", () => {
  const panel = read("src/panel.ts");
  for (const id of ["addmenu", "modemenu", "outputmenu", "modelmenu", "ctxmenu", "cachemenu"]) {
    assert.match(panel, new RegExp(`id="${id}" class="[^"]*\\bdgc-menu\\b`), `Work's #${id}`);
  }
  const chat = read("src/chatdgc.ts");
  for (const id of ["cd-model-menu", "cd-output-menu", "cd-folder-menu"]) {
    assert.match(chat, new RegExp(`id="${id}" class="[^"]*\\bdgc-menu\\b`), `ChatDGC's #${id}`);
  }
  const pips = read("src/pipsClient.js");
  for (const kind of ["composer-model-menu composer-reasoning", "composer-model-menu composer-context-menu", "pip-routines-popover"]) {
    assert.match(pips, new RegExp(`class="${kind} dgc-menu\\b`), `a Pip's ${kind}`);
  }
  const pageMenus = pips.match(/class="tabs-menu[^"]*"/g) || [];
  assert.ok(pageMenus.length >= 3 && pageMenus.every((c) => c === 'class="tabs-menu dgc-menu dgc-menu-rows"'), "a Pip's page menus");
  for (const row of ["composer-model-option", "composer-model-action"]) {
    assert.ok(!new RegExp(`class="${row}(?! dgc-menu-row)[ "]`).test(pips), `every ${row} is a shared row`);
  }
});

test("no menu keeps a look of its own: surface, corner, shadow and rows are the shared menu's", () => {
  const surfaces = [["media/main.css", /(^|\n)\.cmenu \{[^}]*\}/], ["media/chatdgc.css", /\.cd-model-menu \{[^}]*\}/],
    ["media/chatdgc.css", /\.cd-output-menu \{[^}]*\}/], ["src/pips.css", /\.composer-model-menu\{[^}]*\}/],
    ["src/pips.css", /\.pip-routines-popover\{[^}]*\}/], ["src/pips.css", /\.tabs-menu\{position[^}]*\}/]];
  for (const [file, rule] of surfaces) {
    const found = read(file).match(rule)?.[0];
    assert.ok(found, `${file} still places ${rule}`);
    assert.doesNotMatch(found, /box-shadow|border-radius|background|border:/, `${file}: ${found.trim().slice(0, 50)}… draws its own surface`);
  }
  assert.doesNotMatch(read("media/main.css"), /\.cmenu \.mrow \{|\.cmenu \.mhead \{|#addmenu \.mrow-hint/, "Work's rows");
  assert.doesNotMatch(read("media/chatdgc.css"), /\.cd-menu-row \{|\.cd-output-item \{|\.cd-menu-kicker \{|\.cd-output-head \{/, "ChatDGC's rows and kickers");
  assert.doesNotMatch(read("src/pips.css"), /\.tabs-menu button\{|\.composer-model-options button\{/, "the Pips' rows");
});

test("every page loads the shared menu: Work and ChatDGC before their own script, the Pips in their bundle", () => {
  const panel = read("src/panel.ts");
  assert.ok(panel.indexOf('src="${menuJs}"') > 0 && panel.indexOf('src="${menuJs}"') < panel.indexOf('src="${js}"'), "Work: menu.js before main.js");
  const chat = read("src/chatdgc.ts");
  const at = (name) => chat.indexOf(`asset("media/${name}")`);
  assert.ok(at("shared/menu.js") > 0 && at("shared/menu.js") < at("chatdgc.js"), "ChatDGC: menu.js before chatdgc.js");
  assert.match(read("src/pipsClient.js"), /import '\.\.\/media\/shared\/menu\.css';\nimport '\.\.\/media\/shared\/menu\.js';/);
  assert.match(read("media/main.css"), /^@import url\("\.\/shared\/tokens\.css"\);\n@import url\("\.\/shared\/menu\.css"\);/);
});

// ---- window.DgcMenu itself
function page(markup) {
  const dom = new JSDOM(`<!doctype html><body>${markup}</body>`, { runScripts: "outside-only", pretendToBeVisual: true });
  dom.window.eval(read("media/shared/menu.js"));
  return dom;
}
const key = (dom, target, k) => {
  const event = new dom.window.KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
};

test("the keys, the same in every menu: arrows wrap over the rows it can stop on, Home and End, Escape returns to its button, Tab closes", () => {
  const dom = page(`<button id="open">Open</button><div id="menu"><input id="search"><button class="dgc-menu-row" id="a">A</button>
    <button class="dgc-menu-row" id="b" disabled>B</button><div hidden><button class="dgc-menu-row" id="h">H</button></div>
    <button class="dgc-menu-row" id="c" aria-disabled="true">C</button><button class="dgc-menu-row" id="d">D</button><input type="range" id="slider"></div>`);
  const doc = dom.window.document, $ = (id) => doc.getElementById(id), closed = [];
  dom.window.DgcMenu.keys($("menu"), { close: (viaEscape) => closed.push(viaEscape), trigger: $("open") });
  $("a").focus();
  key(dom, $("a"), "ArrowDown"); assert.equal(doc.activeElement.id, "c", "a disabled row and a hidden one are skipped; an aria-disabled one is said, so it stops");
  key(dom, $("c"), "ArrowDown"); assert.equal(doc.activeElement.id, "d");
  key(dom, $("d"), "ArrowDown"); assert.equal(doc.activeElement.id, "a", "Down from the last wraps to the first");
  key(dom, $("a"), "ArrowUp"); assert.equal(doc.activeElement.id, "d", "Up from the first wraps to the last");
  key(dom, $("d"), "Home"); assert.equal(doc.activeElement.id, "a");
  key(dom, $("a"), "End"); assert.equal(doc.activeElement.id, "d");
  $("search").focus();
  assert.equal(key(dom, $("search"), "Home"), false, "Home in a search box is the box's");
  key(dom, $("search"), "ArrowDown"); assert.equal(doc.activeElement.id, "a", "Down from the search box goes to the first row");
  $("slider").focus();
  assert.equal(key(dom, $("slider"), "ArrowDown"), false, "a slider keeps its arrows");
  $("d").focus();
  key(dom, $("d"), "Escape");
  assert.deepEqual(closed, [true]); assert.equal(doc.activeElement.id, "open", "Escape returns to the button that opened it");
  key(dom, $("a"), "Tab");
  assert.deepEqual(closed, [true, false], "Tab closes and lets the focus move on");
});

test("the keys work inside a shadow root too, as a Pip's menus sit in Work's side bar", () => {
  const dom = page(`<div id="host"></div>`);
  const doc = dom.window.document, shadow = doc.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML = `<div id="menu"><button class="dgc-menu-row" id="a">A</button><button class="dgc-menu-row" id="b">B</button><button class="dgc-menu-row" id="c">C</button></div>`;
  const menu = shadow.getElementById("menu");
  dom.window.DgcMenu.keys(menu, {});
  shadow.getElementById("a").focus();
  key(dom, shadow.getElementById("a"), "ArrowDown"); assert.equal(shadow.activeElement.id, "b");
  key(dom, shadow.getElementById("b"), "ArrowDown"); assert.equal(shadow.activeElement.id, "c", "the second Down moves on (it restarted at the top: the document's focus is the host)");
});

test("rows in groups: a heading each, a hairline between, a key cap for a key, quiet words for the rest", () => {
  const dom = page(`<div id="menu"></div>`);
  const menu = dom.window.document.getElementById("menu");
  menu.innerHTML = dom.window.DgcMenu.html([
    { name: "Add to the message", rows: [{ id: "files", icon: "file-directory", label: "Files and folders", hint: "@" }, { id: "mcp", label: "MCP context", hint: "Resources and prompts" }] },
    { name: "This chat", rows: [] },
    { name: "Go to", rows: [{ id: "pips", label: "Pips", hint: "Your Pips" }] }], { data: "add", rowClass: "mrow" });
  assert.deepEqual([...menu.querySelectorAll(".dgc-menu-head")].map((h) => h.textContent), ["Add to the message", "Go to"], "an empty group is left out");
  assert.equal(menu.querySelectorAll(".dgc-menu-div").length, 1);
  const rows = [...menu.querySelectorAll("button.dgc-menu-row.mrow")];
  assert.deepEqual(rows.map((r) => r.dataset.add), ["files", "mcp", "pips"]);
  assert.equal(rows[0].querySelector("kbd.dgc-key")?.textContent, "@");
  assert.equal(rows[1].querySelector("kbd"), null);
  assert.equal(rows[1].querySelector(".dgc-menu-hint").textContent, "Resources and prompts");
  assert.ok(rows.every((r) => r.getAttribute("role") === "menuitem"));
  const picker = page(`<div id="m"></div>`);
  picker.window.document.getElementById("m").innerHTML = picker.window.DgcMenu.html([{ rows: [{ id: "a", label: "A", checked: true }, { id: "b", label: "B" }] }], { role: "menuitemradio" });
  assert.deepEqual([...picker.window.document.querySelectorAll("[role=menuitemradio]")].map((r) => r.getAttribute("aria-checked")), ["true", "false"]);
  assert.match(picker.window.DgcMenu.html([{ rows: [{ id: "x", label: "<b>" }] }]), /&lt;b&gt;/, "labels are text, never markup");
});

// ---- in Chromium: the same menu in all three chats
const LOOK = ([menuSel, rowSel]) => {
  const menu = document.querySelector(menuSel), row = menu.querySelector(rowSel), cm = getComputedStyle(menu), cr = getComputedStyle(row);
  return { menuRadius: cm.borderTopLeftRadius, shadow: cm.boxShadow, border: cm.borderTopColor, menuPad: cm.paddingTop,
           rowHeight: row.offsetHeight /* layout, not the 150 ms open's scale */, rowRadius: cr.borderTopLeftRadius, rowPad: cr.paddingLeft,
           rowFont: cr.fontSize, rowWeight: cr.fontWeight };
};

test("Work's + menu: three groups with headings, key caps for the keys, plain words, and the keys", async (t) => {
  if (skipOrFail(t)) return;
  const s = await openWorkTab(browser, { width: 900, height: 760 });
  try {
    await s.page.click("#btn-add");
    const menu = await s.page.evaluate(() => {
      const m = document.getElementById("addmenu");
      return { heads: [...m.querySelectorAll(".dgc-menu-head")].map((h) => h.textContent),
               keys: [...m.querySelectorAll("kbd")].map((k) => k.textContent),
               rows: [...m.querySelectorAll(".dgc-menu-row")].map((r) => r.dataset.add),
               hintFont: getComputedStyle(m.querySelector(".dgc-menu-hint")).fontFamily,
               focused: document.activeElement?.dataset?.add };
    });
    assert.deepEqual(menu.heads, ["Add to the message", "This chat", "Go to"]);
    assert.deepEqual(menu.keys, ["@", "$", "/"], "the keys you can type instead, as key caps");
    assert.deepEqual(menu.rows.filter((r) => r !== "mcp"), ["files", "skill", "command", "goal", "plan", "pips", "memory"]);
    assert.doesNotMatch(menu.hintFont, /mono/i, "hints in the UI font, not monospace");
    assert.equal(menu.focused, "files", "it opens on its first row");
    const look = await s.page.evaluate(LOOK, ["#addmenu", ".dgc-menu-row"]);
    assert.equal(look.rowHeight, 30); assert.equal(look.rowRadius, "8px"); assert.equal(look.menuRadius, "12px");
    assert.match(look.shadow, /rgba\(0, 0, 0, 0\.28\)/, "the soft lift, not the old black hole of shadow");
    await s.page.keyboard.press("ArrowDown");
    assert.equal(await s.page.evaluate(() => document.activeElement.dataset.add), "skill", "Down moves (it answered no arrows before)");
    await s.page.keyboard.press("End");
    assert.equal(await s.page.evaluate(() => document.activeElement.dataset.add), "memory");
    await s.page.keyboard.press("Escape");
    assert.deepEqual(await s.page.evaluate(() => [document.getElementById("addmenu").hidden, document.activeElement.id]), [true, "btn-add"]);
    assert.deepEqual(s.errors, []);
  } finally { await s.page.close(); }
});

test("ChatDGC's and a Pip's menus draw exactly as Work's, and ChatDGC's model menu answers the same keys", async (t) => {
  if (skipOrFail(t)) return;
  const work = await openWorkTab(browser, { width: 900, height: 760 });
  let workLook;
  try {
    await work.page.click("#btn-mode");
    workLook = await work.page.evaluate(LOOK, ["#modemenu", ".dgc-menu-row"]);
  } finally { await work.page.close(); }

  const chat = await openChat(browser, { width: 900, height: 700 });
  try {
    await chat.send({ type: "opened", conversation: conversation(), messages: [], earlier: 0, busy: false });
    await chat.send({ type: "models", ids: ["deepseek-v4.1-flash:cloud", "glm-5.3:cloud", "qwen3.6:cloud"], current: "glm-5.3:cloud" });
    await chat.page.click("#cd-model-pill");
    const chatLook = await chat.page.evaluate(LOOK, ["#cd-model-menu", ".dgc-menu-row"]);
    assert.deepEqual(chatLook, workLook, "ChatDGC's model menu is Work's menu");
    const focused = () => chat.page.evaluate(() => document.activeElement?.textContent?.trim());
    const order = await chat.page.evaluate(() => [...document.querySelectorAll("#cd-model-menu .dgc-menu-row")].map((r) => r.textContent.trim()));
    const opened = await focused();
    assert.match(opened, /glm-5\.3/, "it opens on the chosen model");
    await chat.page.keyboard.press("ArrowDown");
    assert.equal(await focused(), order[(order.indexOf(opened) + 1) % order.length], "Down moves to the next row (it answered no arrows before)");
    await chat.page.keyboard.press("ArrowUp");
    assert.equal(await focused(), opened, "and Up back");
    await chat.page.keyboard.press("Escape");
    assert.deepEqual(await chat.page.evaluate(() => [document.getElementById("cd-model-menu").hidden, document.activeElement.id]), [true, "cd-model-pill"]);
    await chat.send({ type: "artifacts", offered: OFFER });
    await chat.page.click("#cd-output");
    assert.deepEqual(await chat.page.evaluate(LOOK, ["#cd-output-menu", ".dgc-menu-row"]), workLook, "and so is its Artifact menu");
    // Its words' own width against the box they got: half a pixel short draws "A…" (seen live, 9 Nov).
    const auto = await chat.page.evaluate(() => {
      const l = document.querySelector('#cd-output-menu [data-output="auto"] .dgc-menu-label'), range = document.createRange();
      range.selectNodeContents(l);
      return [range.getBoundingClientRect().width, l.getBoundingClientRect().width];
    });
    assert.ok(auto[1] >= auto[0] - 0.01, `a long hint is cut before the row's name ("Auto" read "A…"): words ${auto[0]}, box ${auto[1]}`);
    await chat.page.keyboard.press("End");
    await chat.page.keyboard.press("Escape");
    assert.deepEqual(await chat.page.evaluate(() => [document.getElementById("cd-output-menu").hidden, document.activeElement.id]), [true, "cd-output"]);
    assert.deepEqual(chat.errors, []);
  } finally { await chat.page.close(); }

  // A Pip's menus, as its bundle styles them (tokens, the shared menu, then pips.css), with the classes its markup carries.
  const pip = await browser.newPage({ viewport: { width: 900, height: 700 }, deviceScaleFactor: 2 });
  try {
    const css = readStylesheet(TOKENS_CSS) + readStylesheet(new URL("../media/shared/menu.css", import.meta.url)) + readStylesheet(new URL("../src/pips.css", import.meta.url));
    await pip.setContent(`<style>${css}</style><style>:root{--vscode-font-family:system-ui,sans-serif;--vscode-editor-font-family:ui-monospace,monospace;${THEMES["dark-modern"]}}</style>
      <body class="vscode-dark pip-app-root"><div class="pip-composer" style="position:relative;margin:420px 40px 0;width:400px">
      <div class="composer-model-menu composer-reasoning dgc-menu from-right" role="dialog"><div class="composer-model-list"><p class="composer-list-title dgc-menu-head">Model</p>
      <div class="composer-model-options" role="listbox"><button type="button" class="composer-model-option dgc-menu-row" role="option" aria-selected="true"><span class="composer-model-check dgc-menu-icon"></span><span class="composer-model-row">glm-5.3:cloud</span></button>
      <button type="button" class="composer-model-option dgc-menu-row" role="option" aria-selected="false"><span class="composer-model-check dgc-menu-icon"></span><span class="composer-model-row">qwen3.6:cloud</span></button></div></div></div></div>
      <details class="pip-menu" open style="margin:20px 40px"><summary>More</summary><div class="tabs-menu dgc-menu dgc-menu-rows"><button type="button">Workspace context</button><button type="button">Notifications</button></div></details></body>`);
    const pipLook = await pip.evaluate(LOOK, [".composer-model-menu", ".composer-model-option"]);
    assert.deepEqual(pipLook, { ...workLook, menuPad: pipLook.menuPad }, "a Pip's model menu is Work's menu");
    assert.equal(pipLook.menuPad, workLook.menuPad, "with the same padding");
    const pageLook = await pip.evaluate(LOOK, [".tabs-menu", "button"]);
    assert.deepEqual(pageLook, workLook, "and so is a Pip's page menu");
  } finally { await pip.close(); }
});
